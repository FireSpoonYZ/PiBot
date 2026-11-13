// 模块 7：Host 持久消息账本门面。组合 openHost（登记）与 openMessageStore
// （消息库）；协议校验在边界做一次，本地 Bot 存在性在此核对，库内规则
// 与 SQL 由 message-store.js/message-queries.js 负责。不启动 Runtime/Harness，
// 不调模型，不新增网络路由。
import { openHost } from './host.js';
import { openMessageStore } from './message-store.js';
import {
  messageError,
  assertId,
  assertRevision,
  normalizeScope,
  normalizePublish,
  normalizePublishGuard,
  normalizeEnvelope,
  normalizePeer,
  normalizeAck,
} from './message-protocol.js';
import {
  normalizeScopeCreate,
  normalizeScopeUpdate,
  normalizeScopeDelete,
  normalizeScopeRecord,
  normalizeScopeListOptions,
  normalizeScopeOfferOptions,
  normalizeScopeAck,
  normalizeInventoryQuery,
  normalizeInventoryPage,
  normalizeHistoryQuery,
  normalizeHistoryPage,
  normalizeMissingRangeQuery,
  normalizeReplicaListOptions,
} from './scope-protocol.js';

export function openMessageLog(options) {
  // openHost 校验 dataRoot 非空绝对路径；失败时未打开任何资源。
  const host = openHost({ dataRoot: options?.dataRoot });
  let store;
  try {
    store = openMessageStore(host.dataRoot, host.deviceId);
  } catch (err) {
    try { host.close(); } catch { /* 打开失败清理不掩盖原错误 */ }
    throw err;
  }

  const deviceId = host.deviceId;

  function assertLocalBot(botId) {
    const bot = host.getBot(botId);
    if (!bot || bot.deviceId !== deviceId) {
      throw messageError('BOT_NOT_FOUND', 'bot not found on this host: ' + botId);
    }
    return bot;
  }

  const installScope = (input) => {
    const scope = normalizeScope(input);
    for (const member of scope.members) {
      if (member.deviceId === deviceId) assertLocalBot(member.botId);
    }
    return store.installScope(scope);
  };

  const getScope = (scopeId, revision) => {
    assertId(scopeId, 'scopeId');
    if (revision !== undefined) assertRevision(revision);
    return store.getScope(scopeId, revision);
  };

  const listScopes = () => store.listScopes();

  const publish = (input, guard) => {
    const pub = normalizePublish(input);
    const normalizedGuard = normalizePublishGuard(guard);
    if (normalizedGuard !== null && pub.author.kind !== 'bot') {
      throw messageError('INVALID_ARGUMENT', 'guarded publish requires a bot author');
    }
    if (pub.author.kind === 'bot') assertLocalBot(pub.author.botId);
    return store.publish(pub, normalizedGuard);
  };

  const getMessage = (messageId) => {
    assertId(messageId, 'messageId');
    return store.getMessage(messageId);
  };

  const receive = (peer, envelope) => {
    const p = normalizePeer(peer);
    const e = normalizeEnvelope(envelope);
    for (const target of e.targets) {
      if (target.deviceId === deviceId) assertLocalBot(target.botId);
    }
    return store.receive(p, e);
  };

  const acknowledge = (peer, ack) => {
    const p = normalizePeer(peer);
    const a = normalizeAck(ack);
    return store.acknowledge(p, a);
  };

  const history = (scopeId, pageOptions) => {
    assertId(scopeId, 'scopeId');
    return store.history(scopeId, pageOptions);
  };

  const inbox = (botId, pageOptions) => {
    assertId(botId, 'botId');
    assertLocalBot(botId);
    return store.inbox(botId, pageOptions);
  };

  const replies = (botId, requestMessageId, options) => {
    assertId(botId, 'botId');
    assertId(requestMessageId, 'requestMessageId');
    assertLocalBot(botId);
    return store.replies(botId, requestMessageId, options);
  };

  const outbox = (options) => store.outbox(options);

  const deliveryStatus = (messageId) => {
    assertId(messageId, 'messageId');
    return store.deliveryStatus(messageId);
  };

  const streamStatus = (scopeId, revision, sourceDeviceId) => {
    assertId(scopeId, 'scopeId');
    assertRevision(revision);
    assertId(sourceDeviceId, 'sourceDeviceId');
    return store.streamStatus(scopeId, revision, sourceDeviceId);
  };

  // ---- 模块 12 托管 scope/副本 API：边界规范化一次，本地 Bot 存在性在此核对。----

  const createScope = (input) => {
    const norm = normalizeScopeCreate(input);
    for (const member of norm.members) {
      if (member.deviceId === deviceId) assertLocalBot(member.botId);
    }
    return store.createScope(norm);
  };

  const updateScope = (scopeId, input) => {
    assertId(scopeId, 'scopeId');
    const norm = normalizeScopeUpdate(input);
    for (const member of norm.members ?? []) {
      if (member.deviceId === deviceId) assertLocalBot(member.botId);
    }
    return store.updateScope(scopeId, norm);
  };

  const deleteScope = (scopeId, input) => {
    assertId(scopeId, 'scopeId');
    const norm = normalizeScopeDelete(input);
    return store.deleteScope(scopeId, norm);
  };

  const getScopeState = (scopeId, revision) => {
    assertId(scopeId, 'scopeId');
    if (revision !== undefined) assertRevision(revision);
    return store.getScopeState(scopeId, revision);
  };

  const listScopeStates = (options) => store.listScopeStates(normalizeScopeListOptions(options));

  const getScopeRecord = (scopeId, revision) => {
    assertId(scopeId, 'scopeId');
    if (revision !== undefined) assertRevision(revision);
    return store.getScopeRecord(scopeId, revision);
  };

  const acceptScopeOffer = (peer, record) => {
    const p = normalizePeer(peer);
    const rec = normalizeScopeRecord(record);
    if (rec.scope.deletedAt === undefined) {
      // 删除墓碑（deletedAt）不校验本机成员是否仍存在，确保先删成员 Bot 后解散群聊的墓碑仍能落库清理；
      // 非墓碑修订仅校验全新安装或本次新加入本机的成员，允许含已删本机成员的既有群继续同步后续修订。
      const existing = store.getScope(rec.scope.scopeId);
      const priorLocalBots = new Set(
        (existing?.members ?? [])
          .filter((member) => member.deviceId === deviceId)
          .map((member) => member.botId)
      );
      for (const member of rec.scope.members) {
        if (member.deviceId === deviceId && !priorLocalBots.has(member.botId)) {
          assertLocalBot(member.botId);
        }
      }
    }
    return store.acceptScopeOffer(p, rec);
  };

  const acknowledgeScope = (peer, ack) => {
    const p = normalizePeer(peer);
    const a = normalizeScopeAck(ack);
    return store.acknowledgeScope(p, a);
  };

  const recordScopeError = (peer, ack, code) => {
    const p = normalizePeer(peer);
    const a = normalizeScopeAck(ack);
    return store.recordScopeError(p, a, code);
  };

  const scopeOffers = (options) => store.scopeOffers(normalizeScopeOfferOptions(options));

  const replicaInventory = (peer, query) => {
    const p = normalizePeer(peer);
    const q = normalizeInventoryQuery(query);
    return store.replicaInventory(p, q);
  };

  const replicaHistory = (peer, query) => {
    const p = normalizePeer(peer);
    const q = normalizeHistoryQuery(query);
    return store.replicaHistory(p, q);
  };

  const nextMissingRange = (query) => store.nextMissingRange(normalizeMissingRangeQuery(query));

  const listScopeReplicas = (scopeId, options) => {
    assertId(scopeId, 'scopeId');
    return store.listScopeReplicas(scopeId, normalizeReplicaListOptions(options));
  };

  const listReplicaPeers = (scopeId) => {
    assertId(scopeId, 'scopeId');
    return store.listReplicaPeers(scopeId);
  };

  const recordReplicaInventory = (peer, query, page) => {
    const p = normalizePeer(peer);
    const q = normalizeInventoryQuery(query);
    const pg = normalizeInventoryPage(page);
    return store.recordReplicaInventory(p, q, pg);
  };

  const importReplicaHistory = (peer, query, page) => {
    const p = normalizePeer(peer);
    const q = normalizeHistoryQuery(query);
    const pg = normalizeHistoryPage(page);
    // 本地 Bot 存在性：记录成员与每个封套目标中的本机 Bot 必须真实存在。
    for (const member of pg.record.scope.members) {
      if (member.deviceId === deviceId) assertLocalBot(member.botId);
    }
    for (const envelope of pg.items) {
      for (const target of envelope.targets) {
        if (target.deviceId === deviceId) assertLocalBot(target.botId);
      }
    }
    return store.importReplicaHistory(p, q, pg);
  };

  const recordReplicaScan = (peer, query, code = null) => {
    const p = normalizePeer(peer);
    const q = normalizeHistoryQuery(query);
    return store.recordReplicaScan(p, q, code);
  };

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const errors = [];
    try { store.close(); } catch (err) { errors.push(err); }
    try { host.close(); } catch (err) { errors.push(err); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'message log close failed');
  };

  return {
    deviceId,
    dataRoot: host.dataRoot,
    installScope,
    getScope,
    listScopes,
    publish,
    getMessage,
    receive,
    acknowledge,
    history,
    inbox,
    replies,
    outbox,
    deliveryStatus,
    streamStatus,
    createScope,
    updateScope,
    deleteScope,
    getScopeState,
    listScopeStates,
    getScopeRecord,
    acceptScopeOffer,
    acknowledgeScope,
    recordScopeError,
    scopeOffers,
    replicaInventory,
    replicaHistory,
    nextMissingRange,
    listScopeReplicas,
    listReplicaPeers,
    recordReplicaInventory,
    importReplicaHistory,
    recordReplicaScan,
    close,
  };
}
