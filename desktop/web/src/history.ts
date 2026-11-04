import type { HistoryEntryChunk } from '../../../host-core/index.js';

type Cursor = Record<string, unknown> | null;
interface HistoryPage<T> {
  items: readonly T[];
  nextCursor: Cursor;
  entryChunk?: HistoryEntryChunk;
}

/** 一次返回完整条目；传输中的分片不进入聊天状态，也不截断原文。 */
export async function readHistoryPage<T>(
  fetchPage: (cursor: Cursor, limit: number, chunked: boolean) => Promise<HistoryPage<T> | null>,
  cursor: Cursor = null,
  limit = 200,
): Promise<HistoryPage<T> | null> {
  const chunks: string[] = [];
  let entryId: number | undefined;
  let offset = 0;
  let chunked = true;
  for (;;) {
    let page: HistoryPage<T> | null;
    try {
      page = await fetchPage(cursor, limit, chunked);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      // 兼容尚未更新的远端 Host；新 Host 的大条目仍由无损分片处理。
      if (chunked && code === 'INVALID_ARGUMENT' && chunks.length === 0) {
        chunked = false;
        continue;
      }
      if (!chunked && code === 'RESPONSE_TOO_LARGE' && limit > 1) {
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      throw error;
    }
    if (!page) return null;
    const chunk = page.entryChunk;
    if (!chunk && chunks.length === 0) return page;
    if (!chunk || typeof chunk.json !== 'string' || chunk.json.length === 0 ||
        typeof chunk.complete !== 'boolean' || !Number.isSafeInteger(chunk.entryId) ||
        chunk.offset !== offset || (entryId !== undefined && chunk.entryId !== entryId)) {
      throw new Error('Invalid history entry chunk');
    }
    entryId = chunk.entryId;
    chunks.push(chunk.json);
    offset += chunk.json.length;
    if (chunk.complete) {
      const entry = JSON.parse(chunks.join(''));
      if (entry?.id !== entryId) throw new Error('History entry chunk identity mismatch');
      return { items: [entry as T], nextCursor: page.nextCursor };
    }
    if (!page.nextCursor) throw new Error('Incomplete history entry');
    cursor = page.nextCursor;
  }
}
