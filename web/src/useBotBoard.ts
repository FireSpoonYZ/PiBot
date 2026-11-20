import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotBoardItem, BotBoardSnapshot } from '../../host-core/index.js';
import { isBotActivityBusy } from './botActivity.ts';

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
export type BotBoardTranslate = (zh: string, en: string) => string;

const defaultBoardText: BotBoardTranslate = (zh, en) =>
  typeof navigator !== 'undefined' && navigator.language.startsWith('en') ? en : zh;

export function botBoardKey(scope: string, deviceId: string, botId: string): string {
  return JSON.stringify([scope, deviceId, botId]);
}

export function isBotBoardInterrupted(activity?: BotBoardItem['activity']): boolean {
  // shortcut: The Host carries the reason in a fixed diagnostic; use a structured reason once available.
  return activity?.phase === 'failed' && activity.error?.code === 'GENERATION_FAILED' &&
    activity.error.message === 'generation failed: interrupted';
}

export function botBoardBucket(item: BotBoardItem, seenId?: string): BoardBucket {
  const { activity } = item;
  if (activity.phase === 'stopping' || activity.phase === 'interrupting') return 'working';
  if (item.attention || (activity.phase === 'failed' && !isBotBoardInterrupted(activity))) return 'attention';
  if (isBotActivityBusy(activity) || item.queuedCount > 0) return 'working';
  if (activity.phase === 'idle' && item.lastResult && item.lastResult.id !== seenId) return 'review';
  return 'idle';
}

// Summaries stay in this client session; only viewed result IDs are persisted.
let boardFlight: Promise<void> = Promise.resolve();
const records = new Map<string, BotBoardRecord>();
const seen = new Map<string, string>();
const seenErrors = new Map<string, string>();
const boardListeners = new Set<() => void>();
const seenPrefix = 'bot-board-seen:v1:';

function notifyBoardListeners(): void {
  for (const listener of boardListeners) listener();
}

export function getBotBoardRecord(key: string): BotBoardRecord | undefined {
  return records.get(key);
}

/**
 * Drops only the target Bot's cached board snapshot and replaces its slot with a
 * unique empty record so any older in-flight getBotBoard write (success or error)
 * cannot overwrite it; other Bots and seen markers stay untouched.
 */
export function invalidateBotBoardTarget(key: string): void {
  if (!key) return;
  records.set(key, {});
  notifyBoardListeners();
}

export async function readBotBoardBatch(
  batch: readonly Pick<BotBoardTarget, 'key' | 'botId' | 'generation' | 'read'>[],
  isCurrent: () => boolean = () => true,
  t: BotBoardTranslate = defaultBoardText,
): Promise<boolean> {
  const first = batch[0];
  if (!first) return false;
  const expected = new Map<string, BotBoardRecord | undefined>();
  for (const target of batch) expected.set(target.key, records.get(target.key));
  let changed = false;
  try {
    const snapshot = await first.read(batch.map(t => t.botId));
    if (!isCurrent()) return false;
    for (const target of batch) {
      if (records.get(target.key) !== expected.get(target.key)) continue;
      const item = snapshot.items.find(item => item.botId === target.botId);
      const error = snapshot.errors.find(error => error.botId === target.botId);
      records.set(target.key, item
        ? { item, updatedAt: snapshot.updatedAt, generation: target.generation }
        : { ...records.get(target.key), error: error?.code === 'BOT_NOT_FOUND'
          ? t('Bot 已不存在，请刷新目录。', 'Bot no longer exists. Please refresh the directory.')
          : t('状态读取失败。', 'Failed to read status.') });
      changed = true;
    }
  } catch {
    if (!isCurrent()) return false;
    const message = t('看板不可用，请检查连接，或更新中心与 Host。', 'Board unavailable. Check your connection or update Center and Host.');
    for (const target of batch) {
      if (records.get(target.key) !== expected.get(target.key)) continue;
      records.set(target.key, { ...records.get(target.key), error: message });
      changed = true;
    }
  }
  return changed;
}

function readSeen(key: string): string | undefined {
  if (seen.has(key)) return seen.get(key);
  const id = localStorage.getItem(seenPrefix + key);
  if (id) seen.set(key, id);
  return id ?? undefined;
}

export function useBotBoard(
  targets: BotBoardTarget[],
  active: boolean,
  t: BotBoardTranslate = defaultBoardText,
) {
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(!document.hidden);
  const [storageError, setStorageError] = useState('');
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const tRef = useRef(t);
  tRef.current = t;
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
    const notify = () => setRevision(value => value + 1);
    boardListeners.add(notify);
    return () => { boardListeners.delete(notify); };
  }, []);
  useEffect(() => {
    try {
      for (const target of targetsRef.current) readSeen(target.key);
      setStorageError(targetsRef.current.map(target => seenErrors.get(target.key)).find(Boolean) ?? '');
      setRevision(value => value + 1);
    } catch {
      setStorageError(tRef.current('无法读取本机查看标记；待查看状态可能不完整。', 'Unable to read local viewed markers; review status may be incomplete.'));
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
            if (await readBotBoardBatch(batch, current, tRef.current) && current()) {
              setRevision(value => value + 1);
            }
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
      const message = tRef.current('查看标记未能保存；本次会话仍有效，重启后可能再次显示待查看。', 'Failed to save viewed marker; valid for this session, may reappear after restart.');
      seenErrors.set(key, message);
      setStorageError(message);
    }
    setRevision(value => value + 1);
  }, []);

  return { records, seen, markViewed, invalidate: invalidateBotBoardTarget, storageError, revision, visible };
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
    const current = target ? board.records.get(target.key) : undefined;
    if (active && board.visible && !document.hidden && target?.online && !current?.error &&
        current?.generation === target.generation && id && current.item?.lastResult?.id === id &&
        visibleTextEntryIds.includes(id)) {
      board.markViewed(target.key, id);
    }
  }, [active, board.visible, board.markViewed, board.records, target?.key, target?.online, target?.generation,
    record?.generation, record?.error, id]);
}
