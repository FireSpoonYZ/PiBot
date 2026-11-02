import { openMessageLog } from './messages.js';
import { assertId, messageError } from './message-protocol.js';
import { inboxQueryKey } from './message-queries.js';
import { getWorkBinding, ensureWorkBinding, WorkContextState, toWorkContextRecord } from './work-context-docs.js';
import { createWorkMessageEntry } from './work-context-codec.js';
import { normalizeHistoryOptions, readPrimaryHistory } from './runtime-history.js';

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 被动工作上下文：读取定向账本，协调库只追加原文不提交输入。
    统一主会话的全局收件导入在 runtime-bot-session（sessions.sync）做；
    本运行时的 scope 导入只服务协调/旧执行历史，绝不推进主会话水位。 */
export function createWorkContextRuntime({ host, harness, context, onBound, getProfile, sessions }) {
  // sessions 依赖仅为装配对称保留；本模块不调用其主会话导入/寻源接口。
  void sessions;
  let log = null;
  let closing = false;
  let closed = false;
  let quiescePromise = null;
  let closePromise = null;
  const inflight = new Set();

  function run(operation) {
    if (closing) return Promise.reject(new Error('work context runtime is closed'));
    const task = Promise.resolve().then(operation);
    inflight.add(task);
    task.then(() => inflight.delete(task), () => inflight.delete(task));
    return task;
  }

  function getMessageLog() {
    if (closed) throw new Error('work context runtime is closed');
    log ??= openMessageLog({ dataRoot: host.dataRoot });
    return log;
  }

  async function authorize(botId, scopeId) {
    assertId(botId, 'botId');
    assertId(scopeId, 'scopeId');
    const bot = host.getBot(botId);
    if (!bot || bot.deviceId !== host.deviceId) {
      throw messageError('BOT_NOT_FOUND', 'bot not found on this host: ' + botId);
    }
    const log = getMessageLog();
    const scope = log.getScope(scopeId);
    if (!scope) throw messageError('SCOPE_NOT_FOUND', 'scope not found: ' + scopeId);
    // 已删除 scope 的工作上下文不再授权：历史账本仍在（scopeHistory 可读），
    // 但不再导入/调度/恢复任何工作。
    if (scope.deletedAt !== undefined) {
      throw messageError('SCOPE_DELETED', 'scope has been deleted: ' + scopeId);
    }
    const binding = await getWorkBinding(harness, botId, scopeId, context);
    if (
      !scope.members.some((member) => member.deviceId === host.deviceId && member.botId === botId) &&
      !binding &&
      log.inbox(botId, { scopeId, limit: 1 }).items.length === 0
    ) {
      throw messageError('SCOPE_FORBIDDEN', 'bot has no membership or targeted receipts in scope: ' + scopeId);
    }
    return { bot, scope, binding };
  }

  function resolveWorkContext(botId, scopeId) {
    return run(() => authorize(botId, scopeId));
  }

  function runMessageOperation(operation) {
    return run(() => operation(getMessageLog()));
  }

  function getWorkContext(botId, scopeId) {
    return run(async () => {
      const { binding } = await authorize(botId, scopeId);
      if (!binding) return null;
      const state = await harness.snapshot(WorkContextState, binding.nativeId, context);
      return toWorkContextRecord(state);
    });
  }

  function syncWorkContext(botId, scopeId, options = {}) {
    return run(async () => {
      if (!isPlainObject(options)) {
        throw messageError('INVALID_ARGUMENT', 'sync options must be a plain object');
      }
      for (const key of Object.keys(options)) {
        if (key !== 'limit') throw messageError('INVALID_ARGUMENT', 'unknown sync option: ' + key);
      }
      const { limit } = normalizeHistoryOptions(options);
      const { bot, scope } = await authorize(botId, scopeId);
      // 人格/工具在事务外计算（读取实际 SOUL 文件），再与绑定一起提交。
      const profile = getProfile(bot.botId, { botId: bot.botId, scopeId: scope.scopeId, kind: scope.kind });
      let binding = null;
      const result = await harness.commit(async (tx) => {
        binding = await ensureWorkBinding(tx, host.deviceId, bot, scope, profile);
        const state = await tx.doc(WorkContextState, binding.nativeId);
        const pageOptions = { scopeId, limit };
        if (state.lastImportedLocalId > 0) {
          pageOptions.cursor = {
            deviceId: host.deviceId,
            kind: 'inbox',
            key: inboxQueryKey(botId, scopeId),
            afterLocalId: state.lastImportedLocalId,
          };
        }
        // 在串行 commit 内按最新水位读一页；账本 SELECT 不属于 SDK Tx 表读取。
        const page = log.inbox(botId, pageOptions);
        for (const item of page.items) {
          await tx.appendEntry(binding.nativeId, createWorkMessageEntry(item, scope.kind));
          state.lastImportedLocalId = item.localId;
        }
        const imported = page.items.length;
        state.importedCount += imported;
        return { context: toWorkContextRecord(state), imported, hasMore: page.nextCursor !== null };
      }, context);
      // 提交成功后（事务外）通知 live 附着等待中的 work watch；观察失败只停止受影响
      // watch，绝不失败/回滚已提交导入。用 Promise.resolve().then 隔离 onBound 的
      // 同步/异步异常，只传协调 binding {nativeId, conversationId}（公开绑定不变）。
      if (binding) {
        void Promise.resolve()
          .then(() => onBound?.(botId, scopeId, {
            nativeId: binding.nativeId,
            conversationId: binding.conversationId,
          }))
          .catch(() => {});
      }
      return result;
    });
  }

  function workHistory(botId, scopeId, options = {}) {
    return run(async () => {
      if (!isPlainObject(options)) {
        throw messageError('INVALID_ARGUMENT', 'history options must be a plain object');
      }
      const { limit, cursor } = normalizeHistoryOptions(options);
      const { binding } = await authorize(botId, scopeId);
      const conversationId = binding?.conversationId ?? null;
      let position;
      if (cursor !== undefined) {
        if (
          !isPlainObject(cursor) ||
          Object.keys(cursor).length !== 2 ||
          !Object.hasOwn(cursor, 'conversationId') ||
          !Object.hasOwn(cursor, 'position') ||
          conversationId === null ||
          cursor.conversationId !== conversationId ||
          !isPlainObject(cursor.position)
        ) {
          throw messageError('INVALID_ARGUMENT', 'cursor does not match this work context');
        }
        position = cursor.position;
      }
      if (!binding) return { botId, scopeId, conversationId, items: [], nextCursor: null };
      const conversation = await harness.conversation(binding.nativeId, context);
      const page = await readPrimaryHistory(conversation, { limit, cursor: position }, context);
      return {
        botId,
        scopeId,
        conversationId,
        items: page.items,
        nextCursor: page.nextCursor === null ? null : { conversationId, position: page.nextCursor },
      };
    });
  }

  function quiesce() {
    if (!quiescePromise) {
      closing = true;
      quiescePromise = Promise.allSettled([...inflight]).then(() => {});
    }
    return quiescePromise;
  }

  function close() {
    if (!closePromise) {
      closePromise = (async () => {
        await quiesce();
        closed = true;
        log?.close();
      })();
    }
    return closePromise;
  }

  return { getWorkContext, syncWorkContext, workHistory, getMessageLog, resolveWorkContext, runMessageOperation, quiesce, close };
}
