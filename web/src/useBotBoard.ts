import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotBoardItem, BotBoardSnapshot } from '../../host-core/index.js';
import { isBotActivityBusy } from './botActivity';

export interface BotBoardTarget {
  key: string;
  hostKey: string;
  generation: string;
  botId: string;
  name: string;
  deviceName: string;
  avatarKey: string;
  isPrimary?: boolean;
  online: boolean;
  read: (botIds: string[]) => Promise<BotBoardSnapshot>;
}

export interface BotBoardRecord {
  item?: BotBoardItem;
  updatedAt?: string;
  error?: string;
  generation?: string;
}

export type BoardBucket = 'attention' | 'working' | 'review' | 'idle' | 'offline';

export function botBoardKey(scope: string, deviceId: string, botId: string): string {
  return JSON.stringify([scope, deviceId, botId]);
}

export function botBoardBucket(item: BotBoardItem, seenId?: string): BoardBucket {
  const { activity } = item;
  if (activity.phase === 'stopping' || activity.phase === 'interrupting') return 'working';
  if (item.attention || activity.phase === 'failed') return 'attention';
  if (isBotActivityBusy(activity) || item.queuedCount > 0) return 'working';
  if (activity.phase === 'idle' && item.lastResult && item.lastResult.id !== seenId) return 'review';
  return 'idle';
}

// Summaries stay in this client session; only viewed result IDs are persisted.
let boardFlight: Promise<void> = Promise.resolve();
const records = new Map<string, BotBoardRecord>();
const seen = new Map<string, string>();
const seenErrors = new Map<string, string>();
const seenPrefix = 'bot-board-seen:v1:';

function readSeen(key: string): string | undefined {
  if (seen.has(key)) return seen.get(key);
  const id = localStorage.getItem(seenPrefix + key);
  if (id) seen.set(key, id);
  return id ?? undefined;
}

export function useBotBoard(targets: BotBoardTarget[], active: boolean) {
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(!document.hidden);
  const [storageError, setStorageError] = useState('');
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  // Labels and callback identities do not restart an in-flight batch.
  const signature = JSON.stringify(targets.map(t => [t.key, t.hostKey, t.generation, t.online]));
  const currentSignature = useRef(signature);
  currentSignature.current = signature;
  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    try {
      for (const target of targetsRef.current) readSeen(target.key);
      setStorageError(targetsRef.current.map(target => seenErrors.get(target.key)).find(Boolean) ?? '');
      setRevision(value => value + 1);
    } catch {
      setStorageError('无法读取本机查看标记；待查看状态可能不完整。');
    }
  }, [signature]);

  useEffect(() => {
    if (!active || !visible) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !disposed && !document.hidden && currentSignature.current === signature;
    const poll = async () => {
      const round = async () => {
        if (!current()) return;
        const groups = new Map<string, BotBoardTarget[]>();
        for (const target of targetsRef.current) {
          if (!target.online) continue;
          const group = groups.get(target.hostKey) ?? [];
          group.push(target);
          groups.set(target.hostKey, group);
        }
        const batches: BotBoardTarget[][] = [];
        for (const group of groups.values()) {
          for (let i = 0; i < group.length; i += 64) batches.push(group.slice(i, i + 64));
        }
        let next = 0;
        const worker = async () => {
          while (current() && next < batches.length) {
            const batch = batches[next++]!;
            const first = batch[0]!;
            try {
              const snapshot = await first.read(batch.map(t => t.botId));
              if (!current()) return;
              for (const target of batch) {
                const item = snapshot.items.find(item => item.botId === target.botId);
                const error = snapshot.errors.find(error => error.botId === target.botId);
                records.set(target.key, item
                  ? { item, updatedAt: snapshot.updatedAt, generation: target.generation }
                  : { ...records.get(target.key), error: error?.code === 'BOT_NOT_FOUND'
                    ? 'Bot 已不存在，请刷新目录。' : '状态读取失败。' });
              }
            } catch {
              if (!current()) return;
              const message = '看板不可用，请检查连接，或更新中心与 Host。';
              for (const target of batch) records.set(target.key, { ...records.get(target.key), error: message });
            }
            if (current()) setRevision(value => value + 1);
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, batches.length) }, worker));
      };
      // Shared across board/chat mounts: a new generation waits for old reads to settle.
      const task = boardFlight.then(round);
      boardFlight = task;
      await task;
      if (current()) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [signature, active, visible]);

  const markViewed = useCallback((key: string, id: string) => {
    if (seen.get(key) === id) return;
    seen.set(key, id);
    try {
      localStorage.setItem(seenPrefix + key, id);
      seenErrors.delete(key);
    } catch {
      const message = '查看标记未能保存；本次会话仍有效，重启后可能再次显示待查看。';
      seenErrors.set(key, message);
      setStorageError(message);
    }
    setRevision(value => value + 1);
  }, []);

  return { records, seen, markViewed, storageError, revision, visible };
}

export type BotBoardState = ReturnType<typeof useBotBoard>;

/** The renderer reports IDs after its own attribution and search filters have been applied. */
export function useMarkViewedBoardResult(
  board: BotBoardState,
  target: BotBoardTarget | undefined,
  active: boolean,
) {
  const record = target ? board.records.get(target.key) : undefined;
  const id = record?.item?.lastResult?.id;
  return useCallback((visibleTextEntryIds: readonly string[]) => {
    if (active && board.visible && !document.hidden && target?.online && !record?.error &&
        record?.generation === target.generation && id && visibleTextEntryIds.includes(id)) {
      board.markViewed(target.key, id);
    }
  }, [active, board.visible, board.markViewed, target?.key, target?.online, target?.generation,
    record?.generation, record?.error, id]);
}
