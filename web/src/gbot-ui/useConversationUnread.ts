import { useCallback, useEffect, useMemo, useState } from 'react';

interface ConversationUnreadRow {
  key: string;
  /** null 表示已知没有消息，undefined 表示消息状态未知。 */
  lastMessageAt: string | null | undefined;
}

const EMPTY_WATERMARKS: ReadonlyMap<string, number> = new Map();
const STORAGE_PREFIX = 'gbot-conversation-read:v1:';

function readWatermarks(namespace: string): ReadonlyMap<string, number> {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + namespace);
    if (!raw) return EMPTY_WATERMARKS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_WATERMARKS;
    return new Map(Object.entries(parsed).filter((entry): entry is [string, number] => (
      typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0
    )));
  } catch {
    return EMPTY_WATERMARKS;
  }
}

function writeWatermarks(namespace: string, watermarks: ReadonlyMap<string, number>): void {
  try {
    const latest = new Map(readWatermarks(namespace));
    for (const [key, at] of watermarks) {
      if (at >= (latest.get(key) ?? 0)) latest.set(key, at);
    }
    window.localStorage.setItem(STORAGE_PREFIX + namespace, JSON.stringify(Object.fromEntries(latest)));
  } catch {
    // 存储不可用时仍保留内存中的已读水位。
  }
}

export function useConversationUnread(
  namespace: string | null,
  rows: readonly ConversationUnreadRow[],
  viewingBotKey: string | null,
): { unread: ReadonlySet<string>; markViewed: (key: string, lastMessageAt: string) => void } {
  const stored = useMemo(
    () => namespace === null ? EMPTY_WATERMARKS : readWatermarks(namespace),
    [namespace],
  );
  const [watermarks, setWatermarks] = useState<ReadonlyMap<string, ReadonlyMap<string, number>>>(() => new Map());
  const current = namespace === null ? EMPTY_WATERMARKS : watermarks.get(namespace) ?? stored;
  const [visible, setVisible] = useState(() => typeof document !== 'undefined' && !document.hidden);
  const activeKey = visible ? viewingBotKey : null;
  const times = useMemo(() => {
    const result = new Map<string, number>();
    for (const { key, lastMessageAt } of rows) {
      if (lastMessageAt === undefined) continue;
      const at = lastMessageAt === null ? 0 : Date.parse(lastMessageAt);
      if (Number.isFinite(at) && at >= 0) result.set(key, at);
    }
    return result;
  }, [rows]);

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const remember = useCallback((entries: Iterable<readonly [string, number]>, viewedKey: string | null) => {
    if (namespace === null) return;
    setWatermarks(previous => {
      const existing = previous.get(namespace) ?? stored;
      let next: Map<string, number> | undefined;
      for (const [key, at] of entries) {
        const readAt = existing.get(key);
        // 已知会话只有实际查看后才推进，晚到的旧快照不能倒退水位。
        if (readAt !== undefined && (key !== viewedKey || at <= readAt)) continue;
        (next ??= new Map(existing)).set(key, at);
      }
      return next ? new Map(previous).set(namespace, next) : previous;
    });
  }, [namespace, stored]);

  useEffect(() => {
    remember(times, activeKey);
  }, [remember, times, activeKey]);

  const changed = namespace === null ? undefined : watermarks.get(namespace);
  useEffect(() => {
    if (namespace !== null && changed) writeWatermarks(namespace, changed);
  }, [namespace, changed]);

  const markViewed = useCallback((key: string, lastMessageAt: string) => {
    const at = Date.parse(lastMessageAt);
    if (Number.isFinite(at) && at >= 0) remember([[key, at]], key);
  }, [remember]);

  const unread = useMemo(() => {
    const result = new Set<string>();
    for (const [key, at] of times) {
      const readAt = current.get(key);
      if (key !== activeKey && readAt !== undefined && at > readAt) result.add(key);
    }
    return result;
  }, [times, current, activeKey]);

  return { unread, markViewed };
}
