import { randomUUID } from 'node:crypto';
import { withoutAbortSignal } from '@earendil-works/chord/context';
import { openVaultStore } from './vault-store.js';
import { resolveBotIdentity } from './bot-identity.js';
import { normalizeVaultControl, normalizeVaultTarget, vaultString, vaultError, safeVaultError } from './vault-protocol.js';

export async function createVaultService({ host, getHarness, shower, isMaintenance }) {
  const store = await openVaultStore({ dataRoot: host.dataRoot,
    isLocalBot: botId => host.getBot(botId)?.deviceId === host.deviceId });
  const pending = new Map();
  let closed = false;
  function finish(request, status) {
    if (pending.get(request.presentation.requestId) !== request) return;
    pending.delete(request.presentation.requestId);
    request.signal?.removeEventListener('abort', request.onAbort);
    request.presentation = { ...request.presentation, status };
    request.resolve(status);
  }
  function interruptPending() {
    for (const request of pending.values()) finish(request, 'interrupted');
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
      await store.control({ action: request.presentation.mode, masterPassword: input.masterPassword }, request);
      return { requestId: input.requestId, status: 'unlocked' };
    } catch (error) {
      // A wrong password is private and retryable; failed authorization or a stale request ends the wait.
      if (error?.code !== 'VAULT_UNLOCK_FAILED') finish(request, 'interrupted');
      throw safeVaultError(error);
    } finally { if (!input.cancelled) request.busy = false; }
  }
  return {
    async control(raw) {
      const input = normalizeVaultControl(raw);
      if (isMaintenance() && input.action !== 'status' && input.action !== 'lock') throw vaultError('RUNTIME_BUSY');
      if (input.action === 'respondUnlock') return respondUnlock(input);
      if (input.action === 'lock') interruptPending();
      return store.control(input);
    },
    async close() { closed = true; interruptPending(); await store.close(); },
    // The manager binds this facade to a particular installed capability. No key,
    // management method or plaintext resolver crosses the plugin service boundary.
    facade(checkOwner, assertAllowed, installationId) {
      async function identity(api, context) {
        if (isMaintenance()) throw vaultError('RUNTIME_BUSY');
        const actor = await resolveBotIdentity(host, getHarness(), api.conversationId, context);
        await checkOwner(api.conversationId);
        return actor;
      }
      return Object.freeze({
        async unlock(args, api, context) {
          let request;
          try {
            if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
              throw vaultError('VAULT_INVALID_ARGUMENT');
            }
            const actor = await identity(api, context);
            assertAllowed(actor.botId);
            const current = await store.control({ action: 'status' });
            if (closed || context.abortSignal?.aborted) throw vaultError('VAULT_REQUEST_EXPIRED');
            if (!current.locked) return { status: 'unlocked' };
            let resolve;
            const waiting = new Promise(done => { resolve = done; });
            request = {
              presentation: { kind: 'vault-unlock', version: 1, installationId,
                conversationId: api.conversationId, requestId: randomUUID(),
                mode: current.initialized ? 'unlock' : 'initialize', status: 'pending' },
              signal: context.abortSignal, resolve, busy: false,
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
            const actor = await identity(api, context);
            assertAllowed(actor.botId);
            return store.find(actor.botId, query);
          } catch (error) { throw safeVaultError(error); }
        },
        async fill(args, api, context) {
          let inputRequested = false;
          try {
            const secretRef = vaultString(args?.secretRef, 128, 1);
            const target = normalizeVaultTarget(args?.target);
            const actor = await identity(api, context);
            const resolve = store.secretReader(secretRef, actor.botId);
            const options = { taskId: api.taskId, callId: api.callId, signal: context.abortSignal, source: 'agent' };
            const current = await shower.status(actor, options);
            if (!current.sessionId) throw vaultError('VAULT_SESSION_REQUIRED');
            inputRequested = true;
            const result = await shower.secretInput(actor, current.sessionId, target, async () => {
              const now = await identity(api, context);
              if (now.botId !== actor.botId || now.conversationId !== actor.conversationId ||
                  now.scopeId !== actor.scopeId) throw vaultError('VAULT_FORBIDDEN');
              assertAllowed(now.botId);
              if (isMaintenance()) throw vaultError('RUNTIME_BUSY');
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
