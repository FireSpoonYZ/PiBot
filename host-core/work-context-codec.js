const EXTERNAL_EVENT_PREFIX = 'External conversation event (actual author in message.author):\n';

/** role:user 仅承载模型上下文；真实作者原样保留在 data.message.author，人仍是 user，Bot 仍是 bot。 */
export function createWorkMessageEntry(storedMessageWithSelfEcho, scopeKind) {
  const data = {
    version: 1,
    scopeKind,
    localId: storedMessageWithSelfEcho.localId,
    digest: storedMessageWithSelfEcho.digest,
    storedAt: storedMessageWithSelfEcho.storedAt,
    selfEcho: storedMessageWithSelfEcho.selfEcho,
    message: storedMessageWithSelfEcho.message,
  };
  // missingRefs 会随后续收件变化，不属于不可变事件；也不在此筛选推理资格。
  return {
    kind: 'host.scope-message',
    data,
    model: [{
      role: 'user',
      content: EXTERNAL_EVENT_PREFIX + JSON.stringify(data),
      timestamp: Date.parse(data.storedAt),
    }],
  };
}
