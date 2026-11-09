import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { apply } from '@earendil-works/chord/delta';
import { BOT_SESSION_CHECKPOINT_INTERVAL, BotSessionState } from './bot-session-context.js';

/** 在持有 Host runtime owner 且 SDK 已打开数据库时调用，先于 Harness 读取文档。 */
export async function migrateBotSessionCheckpoints(storage, dbPath) {
  const definition = BotSessionState.definition;
  const storedKind = JSON.stringify(definition.kind);
  let migrated = 0;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // 只读 Pi Durable 1.5.0 的 SQLite 格式，实际写入始终由 SDK 提交。
      const findDocument = db.prepare(`SELECT id, owner_id, record FROM documents
        WHERE kind = ? AND scope_kind = 'conversation' AND family = 0 AND retired_at IS NULL AND id > ?
        ORDER BY id LIMIT 1`);
      const findBase = db.prepare(`SELECT seq, version FROM document_revisions
        WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1`);
      const hasLongTail = db.prepare(`SELECT 1 FROM document_revisions
        WHERE document_id = ? AND seq > ? ORDER BY seq LIMIT 1 OFFSET ?`);
      const readBase = db.prepare('SELECT content FROM document_revisions WHERE document_id = ? AND seq = ?');
      const readTail = db.prepare(`SELECT kind, version, content FROM document_revisions
        WHERE document_id = ? AND seq > ? ORDER BY seq`);

      for (let row = findDocument.get(storedKind, 0); row; row = findDocument.get(storedKind, row.id)) {
        const base = findBase.get(row.id);
        if (base?.version !== definition.version || !hasLongTail.get(row.id, base.seq, BOT_SESSION_CHECKPOINT_INTERVAL - 1)) continue;
        const record = JSON.parse(row.record);
        if (record?.id !== row.id || record.kind !== definition.kind || record.key !== undefined ||
            record.retiredAt !== undefined || record.scope?.kind !== definition.scope ||
            record.scope.conversationId !== row.owner_id || record.history !== definition.history ||
            record.fork !== definition.fork) continue;

        let value = JSON.parse(readBase.get(row.id, base.seq).content);
        // 使用 SDK 同一套 Chord 增量语义，始终只保留当前状态和正在处理的一行。
        for (const revision of readTail.iterate(row.id, base.seq)) {
          if (revision.kind !== 'delta' || revision.version !== base.version) throw new Error('invalid bot session revision');
          const operations = JSON.parse(revision.content);
          if (!Array.isArray(operations)) throw new Error('invalid bot session operations');
          value = apply(value, operations);
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid bot session state');

        // 读取游标已结束。SDK 原子替换 latest 文档的修订链，后续启动可跳过。
        const result = await storage.commit([[{
          type: 'document.change', id: row.id, content: { kind: 'base', version: base.version, value },
        }]], () => {}, BACKGROUND_CONTEXT);
        if (result.stored !== 1 || result.refused !== undefined) throw new Error('bot session checkpoint was refused');
        migrated++;
      }
    } finally {
      db.close();
    }
  } catch {
    // 解析异常可能包含持久化内容，向外只暴露固定错误。
    throw Object.assign(new Error('bot session checkpoint migration failed'), { code: 'BOT_SESSION_CHECKPOINT_MIGRATION_FAILED' });
  }
  return migrated;
}
