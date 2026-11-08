import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { withoutAbortSignal } from '@earendil-works/chord/context';
import { openVaultStore } from './vault-store.js';
import { resolveBotIdentity } from './bot-identity.js';
import { normalizeVaultControl, normalizeVaultTarget, vaultString, vaultError, safeVaultError } from './vault-protocol.js';

const VAULT_SOURCE_VALUES = ['local', 'vaultwarden'];
// 已损坏的持久记录 ≠ 缺失：绝不把它当作已知 local，新确认仍可覆盖重写。
const SOURCE_DAMAGED = 'damaged';
// 外部控制中撤销/轮换会话的动作：先取消 pending 解锁卡片再转发。
const EXTERNAL_REVOKE_ACTIONS = ['lock', 'logout', 'configure', 'sync'];

export async function createVaultService({ host, getHarness, shower, isMaintenance, centerVault }) {
  const store = await openVaultStore({ dataRoot: host.dataRoot,
    isLocalBot: botId => host.getBot(botId)?.deviceId === host.deviceId });
  const pending = new Map();
  let closed = false;

  // 最近由中心确认的密码库来源（非秘密，仅 'local'|'vaultwarden'）：paired 且
  // 中心不可达时按它决定本地库是否仍可用；从未确认过来源时不退回本地。
  // 未注入 centerVault 的 standalone runtime 永远不查中心，只用本地库。
  const directory = join(host.dataRoot, 'vault');
  const sourcePath = join(directory, 'source.json');
  let persistedSource = null;
  try {
    const saved = JSON.parse(await readFile(sourcePath, 'utf8'));
    persistedSource = VAULT_SOURCE_VALUES.includes(saved?.source) ? saved.source : SOURCE_DAMAGED;
  } catch (error) {
    if (error?.code !== 'ENOENT') persistedSource = SOURCE_DAMAGED;
  }
  let sourceQueue = Promise.resolve();
  async function writeSourceFile(source) {
    try {
      const bytes = JSON.stringify({ version: 1, source });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, randomUUID() + '.tmp');
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await rename(temporary, sourcePath);
      } finally { await unlink(temporary).catch(() => {}); }
    } catch { throw vaultError('VAULT_UNAVAILABLE'); }
  }
  // 原子写成功后才提交内存值；写失败显式 VAULT_UNAVAILABLE（不静默吞错导致
  // 重启后按旧 source 回退），persistedSource 未变时重复调用仍会重试持久化。
  function persistSource(source) {
    if (source === persistedSource) return Promise.resolve();
    const next = sourceQueue.then(() => writeSourceFile(source)).then(() => { persistedSource = source; });
    sourceQueue = next.catch(() => {});
    return next;
  }
  async function trackSource(result) {
    const source = result?.source ?? result?.status?.source;
    if (VAULT_SOURCE_VALUES.includes(source)) await persistSource(source);
  }

  function finish(request, status) {
    if (pending.get(request.presentation.requestId) !== request) return;
    pending.delete(request.presentation.requestId);
    request.signal?.removeEventListener('abort', request.onAbort);
    request.presentation = { ...request.presentation, status };
    // 取消/中断时中止进行中的秘密 HTTP；成功完成不 abort 已应答的正常响应。
    if (status !== 'unlocked') request.controller.abort();
    request.resolve(status);
  }
  function interruptPending() {
    for (const request of pending.values()) finish(request, 'interrupted');
  }

  const isVaultCode = code => typeof code === 'string' && code.startsWith('VAULT_');
  // 中心侧异常一律落到固定 Vault 码；端点缺失（旧中心）为不支持，其余不可达为连接失败。
  function externalError(error) {
    if (isVaultCode(error?.code)) return safeVaultError(error);
    if (error?.code === 'CENTER_VAULT_UNSUPPORTED') return vaultError('VAULT_UNSUPPORTED');
    return vaultError('VAULT_CONNECTION_FAILED');
  }
  async function externalCall(method, input, signal) {
    if (closed || !centerVault || typeof centerVault[method] !== 'function') throw vaultError('VAULT_CONNECTION_FAILED');
    try { return await centerVault[method](input, { signal }); }
    catch (error) { throw externalError(error); }
  }
  // paired 时每次外部路径前向中心确认 source；不可达/异形响应只按最近确认值
  // 判定，绝不假设。standalone（无 centerVault）明确只用本地库。
  async function probeSource(signal) {
    if (!centerVault || typeof centerVault.control !== 'function') return { mode: 'standalone' };
    if (closed) return { mode: 'unreachable' };
    let status;
    try { status = await centerVault.control({ action: 'status' }, { signal }); }
    catch (error) {
      if (isVaultCode(error?.code)) throw safeVaultError(error);
      if (error?.code === 'CENTER_VAULT_UNSUPPORTED') return { mode: 'unsupported' };
      return { mode: 'unreachable' };
    }
    if (!VAULT_SOURCE_VALUES.includes(status?.source)) return { mode: 'unreachable' };
    await persistSource(status.source);
    return status.source === 'vaultwarden' ? { mode: 'external', status } : { mode: 'local', status };
  }
  // external | external-offline | local | unknown-offline
  function effectiveMode(probe) {
    if (probe.mode === 'external') return 'external';
    if (probe.mode === 'local' || probe.mode === 'standalone') return 'local';
    if (persistedSource === 'vaultwarden') return 'external-offline';
    if (persistedSource === 'local') return 'local';
    // 端点缺失的旧中心且从未确认过任何来源才退回本地；记录损坏/未知一律拒绝。
    if (probe.mode === 'unsupported' && persistedSource === null) return 'local';
    return 'unknown-offline';
  }
  function externalStatus(status) {
    return {
      initialized: status?.configured === true,
      locked: status?.locked !== false,
      revision: Number.isSafeInteger(status?.revision) ? status.revision : 0,
      expiresAt: typeof status?.expiresAt === 'string' ? status.expiresAt : null,
      source: 'vaultwarden',
      external: status,
    };
  }
  function statusEpoch(status) {
    const epoch = status?.epoch;
    if (typeof epoch !== 'string' || !epoch) throw vaultError('VAULT_UNAVAILABLE');
    return epoch;
  }
  async function externalStatusCall(input, signal) {
    const status = await externalCall('control', input, signal);
    await trackSource(status);
    return externalStatus(status);
  }

  async function respondUnlock(input) {
    const request = pending.get(input.requestId);
    if (!request) throw vaultError('VAULT_REQUEST_EXPIRED');
    if (!input.cancelled && request.busy) throw vaultError('VAULT_REQUEST_BUSY');
    if (!input.cancelled) request.busy = true;
    try {
      await request.authorize();
      request.guard();
      if (input.cancelled) {
        finish(request, 'cancelled');
        return { requestId: input.requestId, status: 'cancelled' };
      }
      if (request.external) {
        // 发送前核对来源/epoch 与卡片创建时一致；源切换或会话轮换必须失败，
        // 且只用创建时记录的 epoch，绝不取提交时的新 epoch。
        const fresh = await externalCall('control', { action: 'status' }, request.signal);
        if (fresh?.source !== 'vaultwarden' || fresh.epoch !== request.epoch) {
          throw vaultError('VAULT_STALE_SESSION');
        }
        const status = await externalCall('control',
          { action: 'unlock', masterPassword: input.masterPassword, expectedEpoch: request.epoch },
          request.signal);
        request.guard();
        await trackSource(status);
        request.complete();
      } else {
        // 本地卡片只在当前来源仍是本地时有效；源已切外部的旧卡片作废。
        const mode = effectiveMode(await probeSource(request.signal));
        if (mode !== 'local') throw vaultError('VAULT_REQUEST_EXPIRED');
        await store.control({ action: request.presentation.mode, masterPassword: input.masterPassword }, request);
      }
      return { requestId: input.requestId, status: 'unlocked' };
    } catch (error) {
      // A wrong password is private and retryable; failed authorization or a stale request ends the wait.
      if (error?.code !== 'VAULT_UNLOCK_FAILED') finish(request, 'interrupted');
      throw safeVaultError(error);
    } finally { if (!input.cancelled) request.busy = false; }
  }
  return {
    async control(raw, options) {
      const input = normalizeVaultControl(raw);
      const manageable = input.action === 'status' || input.action === 'lock' ||
        (input.action === 'external' && ['status', 'check', 'lock'].includes(input.input.action));
      if (isMaintenance() && !manageable) throw vaultError('RUNTIME_BUSY');
      if (input.action === 'respondUnlock') return respondUnlock(input);
      const signal = options?.signal;
      if (input.action === 'external') {
        // 外部撤销类动作先取消 pending 解锁卡片，迟到的卡片回执不能复活旧会话。
        if (EXTERNAL_REVOKE_ACTIONS.includes(input.input.action)) interruptPending();
        const result = await externalCall('control', input.input, signal);
        await trackSource(result);
        return result;
      }
      const probe = await probeSource(signal);
      const mode = effectiveMode(probe);
      if (input.action === 'status') {
        if (mode === 'external') return externalStatus(probe.status);
        if (mode === 'local') {
          const local = await store.control({ action: 'status' });
          return { ...local, source: 'local', ...(probe.status === undefined ? {} : { external: probe.status }) };
        }
        // external-offline/unknown-offline 不伪造状态：直接报连接失败，UI 显示离线而非未配置。
        throw vaultError('VAULT_CONNECTION_FAILED');
      }
      if (mode === 'external-offline' || mode === 'unknown-offline') throw vaultError('VAULT_CONNECTION_FAILED');
      if (mode === 'external') {
        if (input.action === 'lock') {
          interruptPending();
          return externalStatusCall({ action: 'lock' }, signal);
        }
        if (input.action === 'unlock') {
          return externalStatusCall(
            { action: 'unlock', masterPassword: input.masterPassword, expectedEpoch: statusEpoch(probe.status) },
            signal);
        }
        // 本地条目管理在外部来源下拒绝；本地库文件原位保留，切回 local 后原样可用。
        throw vaultError('VAULT_UNSUPPORTED');
      }
      if (input.action === 'lock') interruptPending();
      const result = await store.control(input);
      return result && typeof result === 'object' && typeof result.locked === 'boolean'
        ? { ...result, source: 'local' } : result;
    },
    async close() { closed = true; interruptPending(); await sourceQueue; await store.close(); },
    // The manager binds this facade to a particular installed capability. No key,
    // management method or plaintext resolver crosses the plugin service boundary.
    facade(checkOwner, assertAllowed, installationId) {
      async function identity(api, context) {
        if (isMaintenance()) throw vaultError('RUNTIME_BUSY');
        const actor = await resolveBotIdentity(host, getHarness(), api.conversationId, context);
        await checkOwner(api.conversationId);
        return actor;
      }
      async function reverify(actor, api, context) {
        if (closed || context.abortSignal?.aborted) throw vaultError('VAULT_REQUEST_EXPIRED');
        const now = await identity(api, context);
        if (now.botId !== actor.botId || now.conversationId !== actor.conversationId ||
            now.scopeId !== actor.scopeId) throw vaultError('VAULT_FORBIDDEN');
        assertAllowed(now.botId);
        if (isMaintenance()) throw vaultError('RUNTIME_BUSY');
      }
      async function routed(api, context) {
        const actor = await identity(api, context);
        assertAllowed(actor.botId);
        const probe = await probeSource(context.abortSignal);
        const mode = effectiveMode(probe);
        if (mode === 'external-offline' || mode === 'unknown-offline') throw vaultError('VAULT_CONNECTION_FAILED');
        return { actor, probe, mode };
      }
      return Object.freeze({
        async unlock(args, api, context) {
          let request;
          try {
            if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
              throw vaultError('VAULT_INVALID_ARGUMENT');
            }
            const { actor, probe, mode } = await routed(api, context);
            let cardMode;
            let external = false;
            let epoch;
            let serverUrl;
            if (mode === 'external') {
              const status = probe.status;
              if (status?.configured !== true) throw vaultError('VAULT_NOT_CONFIGURED');
              if (status?.locked === false) return { status: 'unlocked' };
              external = true;
              cardMode = 'unlock';
              epoch = statusEpoch(status);
              if (typeof status.serverUrl === 'string' && status.serverUrl) serverUrl = status.serverUrl;
            } else {
              const current = await store.control({ action: 'status' });
              if (closed || context.abortSignal?.aborted) throw vaultError('VAULT_REQUEST_EXPIRED');
              if (!current.locked) return { status: 'unlocked' };
              cardMode = current.initialized ? 'unlock' : 'initialize';
            }
            if (closed || context.abortSignal?.aborted) throw vaultError('VAULT_REQUEST_EXPIRED');
            let resolve;
            const waiting = new Promise(done => { resolve = done; });
            const controller = new AbortController();
            const signals = [context.abortSignal, controller.signal].filter(Boolean);
            request = {
              presentation: { kind: 'vault-unlock', version: 1, installationId,
                conversationId: api.conversationId, requestId: randomUUID(),
                mode: cardMode, status: 'pending',
                ...(external ? { source: 'vaultwarden', ...(serverUrl === undefined ? {} : { serverUrl }) } : {}) },
              external,
              epoch,
              controller,
              signal: signals.length ? AbortSignal.any(signals) : undefined,
              resolve, busy: false,
              guard() {
                if (closed || request.signal?.aborted || pending.get(request.presentation.requestId) !== request) {
                  throw vaultError('VAULT_REQUEST_EXPIRED');
                }
                if (isMaintenance()) throw vaultError('RUNTIME_BUSY');
                assertAllowed(actor.botId);
              },
              async authorize() {
                request.guard();
                const now = await identity(api, context);
                if (now.botId !== actor.botId || now.conversationId !== actor.conversationId ||
                    now.scopeId !== actor.scopeId) throw vaultError('VAULT_FORBIDDEN');
                request.guard();
              },
              complete: () => finish(request, 'unlocked'),
              onAbort: () => finish(request, 'interrupted'),
            };
            pending.set(request.presentation.requestId, request);
            request.signal?.addEventListener('abort', request.onAbort, { once: true });
            // Only safe metadata is durable; the waiter and all password processing stay in this Host.
            await api.details({ presentation: request.presentation }, context);
            const status = await waiting;
            if (status === 'interrupted') throw vaultError('VAULT_REQUEST_EXPIRED');
            await api.details({ presentation: request.presentation }, context);
            return { status };
          } catch (error) {
            if (request) {
              finish(request, 'interrupted');
              // An aborted/closed SDK task may no longer accept progress; its old card is read-only.
              await api.details({ presentation: request.presentation }, withoutAbortSignal(context)).catch(() => {});
            }
            throw safeVaultError(error);
          }
        },
        async find(args, api, context) {
          try {
            const query = vaultString(args?.query ?? '', 200).toLowerCase();
            const { actor, mode } = await routed(api, context);
            if (mode === 'external') {
              return await externalCall('find', { botId: actor.botId, installationId, query }, context.abortSignal);
            }
            return store.find(actor.botId, query);
          } catch (error) { throw safeVaultError(error); }
        },
        async fill(args, api, context) {
          let inputRequested = false;
          try {
            const secretRef = vaultString(args?.secretRef, 128, 1);
            const target = normalizeVaultTarget(args?.target);
            const { actor, probe, mode } = await routed(api, context);
            let resolve;
            if (mode === 'external') {
              const status = probe.status;
              if (status?.configured !== true) throw vaultError('VAULT_NOT_CONFIGURED');
              if (status?.authenticated !== true) throw vaultError('VAULT_NEEDS_LOGIN');
              if (status?.locked !== false) throw vaultError('VAULT_LOCKED');
              const epoch = statusEpoch(status);
              // 真正的 resolve 只发生一次且在 secretInput 队头的 resolveText 回调里，
              // 不自动重试；取回前后都重验 source/epoch/锁定/身份/能力/取消，
              // 取回途中源或授权已变的密码一律作废。
              resolve = async () => {
                const fresh = await externalCall('control', { action: 'status' }, context.abortSignal);
                if (fresh?.source !== 'vaultwarden' || fresh.locked !== false || fresh.epoch !== epoch) {
                  throw vaultError('VAULT_STALE_SESSION');
                }
                const resolved = await externalCall('resolve',
                  { botId: actor.botId, installationId, secretRef, expectedEpoch: epoch }, context.abortSignal);
                if (typeof resolved?.password !== 'string' || resolved.epoch !== epoch) {
                  throw vaultError('VAULT_UNAVAILABLE');
                }
                await reverify(actor, api, context);
                const latest = await externalCall('control', { action: 'status' }, context.abortSignal);
                if (latest?.source !== 'vaultwarden' || latest.locked !== false || latest.epoch !== epoch) {
                  throw vaultError('VAULT_STALE_SESSION');
                }
                return resolved.password;
              };
            } else {
              resolve = store.secretReader(secretRef, actor.botId);
            }
            const options = { taskId: api.taskId, callId: api.callId, signal: context.abortSignal, source: 'agent' };
            const current = await shower.status(actor, options);
            if (!current.sessionId) throw vaultError('VAULT_SESSION_REQUIRED');
            inputRequested = true;
            const result = await shower.secretInput(actor, current.sessionId, target, async () => {
              await reverify(actor, api, context);
              return resolve();
            }, options);
            return { sessionId: result.sessionId, status: result.status };
          } catch (error) {
            if (error?.code === 'SHOWER_UNSUPPORTED' && error?.outcome === 'not-sent') {
              throw vaultError('VAULT_INPUT_UNSUPPORTED');
            }
            // Only the private input path can establish that dispatch did not occur.
            if (inputRequested && error?.outcome !== 'not-sent') throw vaultError('VAULT_INPUT_UNCONFIRMED');
            throw safeVaultError(error);
          }
        },
      });
    },
  };
}
