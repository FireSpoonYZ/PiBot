import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotLiveState, LiveTool, MessageMember, StoredMessage } from '../../host-core/index.js';
import type { DesktopIdentity, DesktopObservationEvent, ObservationHandle } from '../../desktop/web/src/types';
import type { MemberApiResolver, ScopeReadApi } from '../../desktop/web/src/scope-api';
import { HistoryEpochChangedError, readHistoryPage } from '../../desktop/web/src/history';
import type { MemberPrimarySourceState } from './dmScopeTimeline';

export const MAX_DM_RAW_HISTORY_PAGES = 50;
const DM_RAW_HISTORY_PAGE_LIMIT = 200;
const MAX_EPOCH_RETRIES = 3;

const OFFLINE_ERROR_CODES = new Set([
  'OFFLINE',
  'CONTROL_UNAVAILABLE',
  'DISCONNECTED',
  'NOT_CONNECTED',
]);

export interface UseDmScopeExecutionOptions {
  /** Strictly true ONLY for DM scopes (`scope.scope.kind === 'dm'`). Never enable for room scopes. */
  enabled: boolean;
  scopeId: string;
  members: readonly MessageMember[];
  fallbackApi: ScopeReadApi;
  resolveMemberApi?: MemberApiResolver;
  /** Active viewport + visible document (`pageActive && docVisible`). */
  active: boolean;
  /** Canonical ledger messages from `scopeHistory`, used to trigger incremental tail refresh on new member messages. */
  ledgerMessages?: readonly StoredMessage[];
  /** Triggered when any member's live `busy` transitions `true -> false` or a `send_to` tool settles while open. */
  onMemberSettled?: () => void;
}

export interface UseDmScopeExecutionResult {
  sources: MemberPrimarySourceState[];
}

function memberKeyOf(member: MessageMember): string {
  return `${member.deviceId}:${member.botId}`;
}

function identitySessionKey(id: DesktopIdentity | null | undefined): string {
  return id ? `${id.profileId}|${id.kind}|${id.generation}|${id.targetDeviceId}` : '';
}

function identityTargetPrefix(id: DesktopIdentity | null | undefined): string {
  return id ? `${id.profileId}|${id.kind}|${id.targetDeviceId}` : '';
}

function readErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const rawCode = (error as { code?: unknown }).code;
    if (typeof rawCode === 'string' && rawCode.trim()) {
      return rawCode.trim().toUpperCase();
    }
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = /^([A-Z][A-Z0-9_]{2,32})(?::|\s|$)/.exec(message.trim());
  return match ? match[1] : '';
}

function readClearedThrough(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function numericEntryId(item: { id?: unknown } | null | undefined): number {
  if (!item) return 0;
  const raw = item.id;
  const id = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(id) ? id : 0;
}

function maxResetEntryId(items: ReadonlyArray<{ id?: unknown; kind?: unknown }> | null | undefined): number {
  if (!Array.isArray(items)) return 0;
  let max = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || item.kind !== 'pi.reset') continue;
    const id = numericEntryId(item);
    if (Number.isSafeInteger(id) && id > max) max = id;
  }
  return max;
}

function entryMapKey(item: Record<string, unknown>, fallbackSeq: number): string {
  if (item.id !== undefined && item.id !== null && String(item.id) !== '') {
    return String(item.id);
  }
  return `__anon_${fallbackSeq}`;
}

function snapshotSortedEntries(
  byId: ReadonlyMap<string, Record<string, unknown>>,
  cutoff: number,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const item of byId.values()) {
    if (item.kind === 'pi.reset') continue;
    const id = numericEntryId(item);
    if (cutoff > 0 && id > 0 && id <= cutoff) continue;
    out.push(item);
  }
  out.sort((a, b) => numericEntryId(a) - numericEntryId(b));
  return out;
}

function resolveApiForMember(
  member: MessageMember | null,
  enabled: boolean,
  resolveMemberApi: MemberApiResolver | undefined,
  fallbackApi: ScopeReadApi,
): ScopeReadApi | null {
  if (!enabled || !member) return null;
  if (resolveMemberApi) {
    const resolved = resolveMemberApi(member.deviceId);
    if (resolved && resolved.identity?.targetDeviceId === member.deviceId) {
      return resolved;
    }
  }
  if (fallbackApi.identity?.targetDeviceId === member.deviceId) {
    return fallbackApi;
  }
  return null;
}

function maxLedgerLocalIdForMember(
  ledgerMessages: readonly StoredMessage[] | undefined,
  member: MessageMember | null,
  scopeId: string,
): number {
  if (!ledgerMessages || !member) return 0;
  let maxId = 0;
  for (const stored of ledgerMessages) {
    const env = stored.message;
    if (env.scopeId && env.scopeId !== scopeId) continue;
    if (env.author.kind !== 'bot' || env.author.botId !== member.botId) continue;
    if (member.deviceId && env.sourceDeviceId && env.sourceDeviceId !== member.deviceId) continue;
    if (typeof stored.localId === 'number' && stored.localId > maxId) {
      maxId = stored.localId;
    }
  }
  return maxId;
}

function collectSendToCallIds(tools: readonly LiveTool[] | null | undefined): {
  running: Set<string>;
  done: Set<string>;
} {
  const running = new Set<string>();
  const done = new Set<string>();
  if (!Array.isArray(tools)) return { running, done };
  for (const tool of tools) {
    if (!tool || tool.name !== 'send_to' || typeof tool.callId !== 'string' || !tool.callId) continue;
    if (tool.status === 'done') {
      done.add(tool.callId);
    } else {
      running.add(tool.callId);
    }
  }
  return { running, done };
}

interface RawSlotState {
  scopeId: string;
  memberKey: string;
  entries: Array<Record<string, unknown>>;
  clearedThroughEntryId: number;
}

interface LiveSlotState {
  scopeId: string;
  memberKey: string;
  session: string;
  state: BotLiveState;
}

interface UnavailableSlotState {
  scopeId: string;
  memberKey: string;
  session: string;
  reason: 'offline' | 'not_found';
}

interface RawFlight {
  epoch: number;
  dirty: boolean;
  resetToStart: boolean;
}

function useDmMemberPrimarySource({
  enabled,
  scopeId,
  member,
  memberApi,
  active,
  memberLatestLedgerId,
  onMemberSettledRef,
}: {
  enabled: boolean;
  scopeId: string;
  member: MessageMember | null;
  memberApi: ScopeReadApi | null;
  active: boolean;
  memberLatestLedgerId: number;
  onMemberSettledRef: { current: (() => void) | undefined };
}): MemberPrimarySourceState | null {
  const hasMember = member !== null;
  const memberDeviceId = member?.deviceId ?? '';
  const memberBotId = member?.botId ?? '';
  const stableMember = useMemo<MessageMember | null>(
    () => (hasMember ? { deviceId: memberDeviceId, botId: memberBotId } : null),
    [hasMember, memberDeviceId, memberBotId],
  );
  const mKey = stableMember ? memberKeyOf(stableMember) : '';
  const identity = enabled && stableMember && memberApi ? memberApi.identity : null;
  const identityRef = useRef<DesktopIdentity | null>(identity);
  identityRef.current = identity;
  const latestLedgerIdRef = useRef(memberLatestLedgerId);
  latestLedgerIdRef.current = memberLatestLedgerId;
  const sess = identitySessionKey(identity);
  const targetPrefix = identityTargetPrefix(identity);
  const online = Boolean(enabled && stableMember && memberApi && identity && memberApi.transportConnected);

  const [rawState, setRawState] = useState<RawSlotState>(() => ({
    scopeId,
    memberKey: mKey,
    entries: [],
    clearedThroughEntryId: 0,
  }));
  const [liveState, setLiveState] = useState<LiveSlotState | null>(null);
  const [runtimeUnavailable, setRuntimeUnavailable] = useState<UnavailableSlotState | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const epochRef = useRef(0);
  const rawByIdRef = useRef<Map<string, Record<string, unknown>>>(new Map());
  const tailPageCursorRef = useRef<Record<string, unknown> | null>(null);
  const cutoffRef = useRef(0);
  const flightRef = useRef<RawFlight | null>(null);
  const unavailableRef = useRef<UnavailableSlotState | null>(null);
  const liveStateRef = useRef<LiveSlotState | null>(null);
  const prevBusyRef = useRef(false);
  const prevRunningSendToIdsRef = useRef<Set<string>>(new Set());
  const prevDoneSendToIdsRef = useRef<Set<string>>(new Set());
  const prevContextRef = useRef<{ scopeId: string; memberKey: string; targetPrefix: string }>({
    scopeId,
    memberKey: mKey,
    targetPrefix,
  });
  const prevLedgerIdRef = useRef<{ scopeId: string; memberKey: string; maxId: number }>({
    scopeId,
    memberKey: mKey,
    maxId: memberLatestLedgerId,
  });

  const markUnavailable = useCallback(
    (reason: 'offline' | 'not_found', localScopeId: string, localMemberKey: string, localSess: string) => {
      const next: UnavailableSlotState = {
        scopeId: localScopeId,
        memberKey: localMemberKey,
        session: localSess,
        reason,
      };
      unavailableRef.current = next;
      setRuntimeUnavailable(next);
      liveStateRef.current = null;
      setLiveState(null);
      prevBusyRef.current = false;
      prevRunningSendToIdsRef.current.clear();
      prevDoneSendToIdsRef.current.clear();
    },
    [],
  );

  const clearOfflineUnavailable = useCallback(
    (localScopeId: string, localMemberKey: string, localSess: string) => {
      const cur = unavailableRef.current;
      if (
        cur &&
        cur.reason === 'offline' &&
        cur.scopeId === localScopeId &&
        cur.memberKey === localMemberKey &&
        cur.session === localSess
      ) {
        unavailableRef.current = null;
        setRuntimeUnavailable(null);
      }
    },
    [],
  );

  const advanceCutoff = useCallback(
    (nextCutoff: number, localScopeId: string, localMemberKey: string): boolean => {
      if (!Number.isSafeInteger(nextCutoff) || nextCutoff <= cutoffRef.current) return false;
      cutoffRef.current = nextCutoff;
      for (const [k, item] of rawByIdRef.current.entries()) {
        const id = numericEntryId(item);
        if (item.kind === 'pi.reset' || (id > 0 && id <= nextCutoff)) {
          rawByIdRef.current.delete(k);
        }
      }
      setRawState({
        scopeId: localScopeId,
        memberKey: localMemberKey,
        entries: snapshotSortedEntries(rawByIdRef.current, nextCutoff),
        clearedThroughEntryId: nextCutoff,
      });
      return true;
    },
    [],
  );

  // Reset per-member caches when disabled, scopeId changes, member changes, or target profile/kind/device changes.
  useEffect(() => {
    const prev = prevContextRef.current;
    const contextChanged =
      !enabled ||
      !hasMember ||
      prev.scopeId !== scopeId ||
      prev.memberKey !== mKey ||
      (prev.targetPrefix !== '' && targetPrefix !== '' && prev.targetPrefix !== targetPrefix);
    prevContextRef.current = {
      scopeId,
      memberKey: mKey,
      targetPrefix: targetPrefix || (prev.scopeId === scopeId && prev.memberKey === mKey ? prev.targetPrefix : ''),
    };
    if (!contextChanged) return;

    epochRef.current += 1;
    rawByIdRef.current.clear();
    tailPageCursorRef.current = null;
    cutoffRef.current = 0;
    flightRef.current = null;
    unavailableRef.current = null;
    liveStateRef.current = null;
    prevBusyRef.current = false;
    prevRunningSendToIdsRef.current.clear();
    prevDoneSendToIdsRef.current.clear();
    prevLedgerIdRef.current = { scopeId, memberKey: mKey, maxId: latestLedgerIdRef.current };

    setRawState({ scopeId, memberKey: mKey, entries: [], clearedThroughEntryId: 0 });
    setLiveState(null);
    setRuntimeUnavailable(null);
  }, [enabled, scopeId, hasMember, mKey, targetPrefix]);

  // Invalidate any stale async work whenever active, online, or session generation changes.
  useEffect(() => {
    epochRef.current += 1;
    flightRef.current = null;
    prevBusyRef.current = false;
    prevRunningSendToIdsRef.current.clear();
    prevDoneSendToIdsRef.current.clear();
    if (!online || !active) {
      liveStateRef.current = null;
      setLiveState(null);
    }
    const curUnavail = unavailableRef.current;
    if (
      curUnavail &&
      (curUnavail.scopeId !== scopeId ||
        curUnavail.memberKey !== mKey ||
        curUnavail.session !== sess ||
        (curUnavail.reason === 'offline' && online))
    ) {
      unavailableRef.current = null;
      setRuntimeUnavailable(null);
    }
    return () => {
      epochRef.current += 1;
      flightRef.current = null;
    };
  }, [enabled, scopeId, mKey, sess, online, active]);

  // Tier 2: Single-flight background raw history hydration with tailPageCursor resume.
  const drainRawHistory = useCallback(
    async (forceRestart = false) => {
      const currentIdentity = identityRef.current;
      if (!enabled || !active || !online || !stableMember || !memberApi || !currentIdentity) return;
      const curUnavail = unavailableRef.current;
      if (
        curUnavail &&
        curUnavail.reason === 'not_found' &&
        curUnavail.scopeId === scopeId &&
        curUnavail.memberKey === mKey &&
        curUnavail.session === sess
      ) {
        return;
      }

      const localEpoch = epochRef.current;
      const localSess = sess;
      const localScopeId = scopeId;
      const localMemberKey = mKey;

      const existingFlight = flightRef.current;
      if (existingFlight && existingFlight.epoch === localEpoch) {
        existingFlight.dirty = true;
        if (forceRestart) existingFlight.resetToStart = true;
        return;
      }

      const flight: RawFlight = {
        epoch: localEpoch,
        dirty: false,
        resetToStart: false,
      };
      flightRef.current = flight;

      const isFresh = (): boolean =>
        mountedRef.current &&
        epochRef.current === localEpoch &&
        flightRef.current === flight &&
        memberApi.transportConnected &&
        identitySessionKey(memberApi.identity) === localSess;

      try {
        if (forceRestart) {
          tailPageCursorRef.current = null;
        }

        let restartFromStart = forceRestart;

        for (let attempt = 0; attempt <= MAX_EPOCH_RETRIES; attempt += 1) {
          if (!isFresh()) return;

          const startCursor = restartFromStart ? null : tailPageCursorRef.current;
          let cursor: Record<string, unknown> | null = startCursor;
          let lastNonEmptyCursor: Record<string, unknown> | null = startCursor;
          let sawNonEmptyPage = false;
          let hasEpoch = false;
          let passEpoch: number | undefined;
          let epochChanged = false;
          let anonSeq = 0;
          const passById = startCursor === null ? new Map<string, Record<string, unknown>>() : null;
          let reachedCap = false;
          let nextAfterCap: Record<string, unknown> | null = null;

          try {
            for (let pageNo = 0; pageNo < MAX_DM_RAW_HISTORY_PAGES; pageNo += 1) {
              if (!isFresh()) return;
              const pageStartCursor = cursor;
              const page = await readHistoryPage<Record<string, unknown>>(
                async (c, limit, chunked) => {
                  if (!isFresh()) return null;
                  const raw = await memberApi.call(currentIdentity, 'history', {
                    botId: stableMember.botId,
                    limit,
                    cursor: c,
                    ...(chunked ? { chunked: true } : {}),
                  });
                  if (!isFresh()) return null;
                  return {
                    items: raw.items as unknown as readonly Record<string, unknown>[],
                    nextCursor: raw.nextCursor,
                    entryChunk: raw.entryChunk,
                    clearedThroughEntryId: raw.clearedThroughEntryId,
                  };
                },
                cursor,
                DM_RAW_HISTORY_PAGE_LIMIT,
              );

              if (!page || !isFresh()) return;

              clearOfflineUnavailable(localScopeId, localMemberKey, localSess);

              const pageCleared = readClearedThrough(page.clearedThroughEntryId);
              if (!hasEpoch) {
                hasEpoch = true;
                passEpoch = pageCleared;
              } else if (pageCleared !== passEpoch) {
                if (pageCleared !== undefined) {
                  advanceCutoff(pageCleared, localScopeId, localMemberKey);
                }
                epochChanged = true;
                break;
              }

              if (pageCleared !== undefined && pageCleared > cutoffRef.current) {
                advanceCutoff(pageCleared, localScopeId, localMemberKey);
                if (startCursor !== null) {
                  epochChanged = true;
                  break;
                }
              }

              const items = Array.isArray(page.items) ? page.items : [];
              const resetInItems = maxResetEntryId(items);
              if (resetInItems > cutoffRef.current) {
                advanceCutoff(resetInItems, localScopeId, localMemberKey);
                epochChanged = true;
                break;
              }

              const next =
                page.nextCursor && typeof page.nextCursor === 'object' && !Array.isArray(page.nextCursor)
                  ? page.nextCursor
                  : null;

              if (items.length > 0) {
                sawNonEmptyPage = true;
                lastNonEmptyCursor = pageStartCursor;
                let addedOrChanged = false;
                const cutoff = cutoffRef.current;

                for (const item of items) {
                  if (!item || typeof item !== 'object') continue;
                  if (item.kind === 'pi.reset') continue;
                  const id = numericEntryId(item);
                  if (cutoff > 0 && id > 0 && id <= cutoff) continue;
                  anonSeq += 1;
                  const key = entryMapKey(item, anonSeq);
                  if (passById) {
                    passById.set(key, item);
                  }
                  const prevItem = rawByIdRef.current.get(key);
                  if (!prevItem) {
                    addedOrChanged = true;
                  }
                  rawByIdRef.current.set(key, item);
                }

                if (addedOrChanged && isFresh()) {
                  setRawState({
                    scopeId: localScopeId,
                    memberKey: localMemberKey,
                    entries: snapshotSortedEntries(rawByIdRef.current, cutoffRef.current),
                    clearedThroughEntryId: cutoffRef.current,
                  });
                }
              }

              if (!next) {
                if (sawNonEmptyPage) {
                  tailPageCursorRef.current = lastNonEmptyCursor;
                }
                break;
              }

              if (pageNo === MAX_DM_RAW_HISTORY_PAGES - 1) {
                reachedCap = true;
                nextAfterCap = next;
                break;
              }

              cursor = next;
            }
          } catch (err) {
            if (!isFresh()) return;
            const code = readErrorCode(err);
            if (err instanceof HistoryEpochChangedError || code === 'HISTORY_EPOCH_CHANGED') {
              tailPageCursorRef.current = null;
              restartFromStart = true;
              continue;
            }
            if (code === 'INVALID_ARGUMENT' && cursor !== null) {
              tailPageCursorRef.current = null;
              rawByIdRef.current.clear();
              restartFromStart = true;
              continue;
            }
            if (code === 'BOT_NOT_FOUND') {
              markUnavailable('not_found', localScopeId, localMemberKey, localSess);
              return;
            }
            if (OFFLINE_ERROR_CODES.has(code)) {
              markUnavailable('offline', localScopeId, localMemberKey, localSess);
              return;
            }
            // Non-blocking secondary trace fetch: never reportError or disrupt DM ledger.
            return;
          }

          if (!isFresh()) return;

          if (epochChanged) {
            tailPageCursorRef.current = null;
            restartFromStart = true;
            continue;
          }

          if (reachedCap && nextAfterCap) {
            // Retain continuation cursor so subsequent refreshes advance toward the tail.
            tailPageCursorRef.current = nextAfterCap;
          }

          // When a full start-to-tail drain completed cleanly, replace rawByIdRef so edited/cleared entries vanish.
          if (passById && !reachedCap) {
            const cutoff = cutoffRef.current;
            const prevSize = rawByIdRef.current.size;
            let keysDiffer = prevSize !== passById.size;
            if (!keysDiffer) {
              for (const key of passById.keys()) {
                if (!rawByIdRef.current.has(key)) {
                  keysDiffer = true;
                  break;
                }
              }
            }
            rawByIdRef.current = passById;
            if (keysDiffer || passById.size > 0) {
              setRawState({
                scopeId: localScopeId,
                memberKey: localMemberKey,
                entries: snapshotSortedEntries(passById, cutoff),
                clearedThroughEntryId: cutoff,
              });
            }
          }

          return;
        }
      } finally {
        if (flightRef.current === flight) {
          flightRef.current = null;
          if (flight.dirty && mountedRef.current && epochRef.current === localEpoch) {
            void drainRawHistory(flight.resetToStart);
          }
        }
      }
    },
    [
      enabled,
      active,
      online,
      stableMember,
      memberApi,
      scopeId,
      mKey,
      sess,
      advanceCutoff,
      clearOfflineUnavailable,
      markUnavailable,
    ],
  );

  // Trigger initial/reconnect Tier 2 background hydration when active & online.
  useEffect(() => {
    if (!enabled || !active || !online || !stableMember || !memberApi || !sess) return;
    void drainRawHistory(false);
  }, [enabled, active, online, stableMember, memberApi, sess, drainRawHistory]);

  // Trigger incremental tail refresh whenever a new ledger message authored by this member arrives.
  useEffect(() => {
    const prev = prevLedgerIdRef.current;
    if (prev.scopeId !== scopeId || prev.memberKey !== mKey) {
      prevLedgerIdRef.current = { scopeId, memberKey: mKey, maxId: memberLatestLedgerId };
      return;
    }
    if (memberLatestLedgerId > prev.maxId) {
      prevLedgerIdRef.current = { scopeId, memberKey: mKey, maxId: memberLatestLedgerId };
      if (enabled && active && online) {
        void drainRawHistory(false);
      }
    }
  }, [enabled, active, online, scopeId, mKey, memberLatestLedgerId, drainRawHistory]);

  // Tier 1: Live primary observation for instant first paint & streaming updates.
  useEffect(() => {
    const currentIdentity = identityRef.current;
    if (!enabled || !active || !online || !stableMember || !memberApi || !currentIdentity) return;
    const curUnavail = unavailableRef.current;
    if (
      curUnavail &&
      curUnavail.reason === 'not_found' &&
      curUnavail.scopeId === scopeId &&
      curUnavail.memberKey === mKey &&
      curUnavail.session === sess
    ) {
      return;
    }

    const localEpoch = epochRef.current;
    const localSess = sess;
    const localScopeId = scopeId;
    const localMemberKey = mKey;
    let disposed = false;
    let handle: ObservationHandle | null = null;

    const isFresh = (): boolean =>
      !disposed &&
      mountedRef.current &&
      epochRef.current === localEpoch &&
      identitySessionKey(memberApi.identity) === localSess;

    const closeHandle = () => {
      const h = handle;
      handle = null;
      if (h) void h.close().catch(() => {});
    };

    const handleLiveTransition = (nextState: BotLiveState, isSnapshot: boolean) => {
      const wasBusy = prevBusyRef.current;
      const isNowBusy = Boolean(nextState.busy);
      prevBusyRef.current = isNowBusy;

      const { running: nextRunningSendToIds, done: nextDoneSendToIds } = collectSendToCallIds(nextState.tools);
      let sendToSettled = false;
      if (!isSnapshot) {
        for (const prevCallId of prevRunningSendToIdsRef.current) {
          if (!nextRunningSendToIds.has(prevCallId)) {
            sendToSettled = true;
            break;
          }
        }
        if (!sendToSettled) {
          for (const doneCallId of nextDoneSendToIds) {
            if (!prevDoneSendToIdsRef.current.has(doneCallId)) {
              sendToSettled = true;
              break;
            }
          }
        }
      }
      prevRunningSendToIdsRef.current = nextRunningSendToIds;
      prevDoneSendToIdsRef.current = nextDoneSendToIds;

      const busySettled = wasBusy && !isNowBusy;
      if (busySettled || sendToSettled) {
        onMemberSettledRef.current?.();
      }
      if (busySettled) {
        void drainRawHistory(false);
      }
    };

    try {
      const h = memberApi.observe(
        currentIdentity,
        { kind: 'primary', botId: stableMember.botId },
        (ev: DesktopObservationEvent) => {
          if (!isFresh()) return;

          if ('error' in ev) {
            const code = readErrorCode(ev.error);
            if (code === 'BOT_NOT_FOUND') {
              markUnavailable('not_found', localScopeId, localMemberKey, localSess);
              closeHandle();
              return;
            }
            if (OFFLINE_ERROR_CODES.has(code)) {
              markUnavailable('offline', localScopeId, localMemberKey, localSess);
              closeHandle();
              return;
            }
            return;
          }

          const frame = ev.frame;
          if (frame.type === 'end') {
            const wasBusy = prevBusyRef.current;
            liveStateRef.current = null;
            setLiveState(null);
            prevBusyRef.current = false;
            prevRunningSendToIdsRef.current.clear();
            prevDoneSendToIdsRef.current.clear();
            closeHandle();
            if (wasBusy) {
              onMemberSettledRef.current?.();
            }
            void drainRawHistory(false);
            return;
          }
          if (frame.type === 'browser-frame') return;
          if ('scopeId' in frame && typeof frame.scopeId === 'string') return;

          clearOfflineUnavailable(localScopeId, localMemberKey, localSess);

          if (frame.type === 'snapshot') {
            const resetId = maxResetEntryId(frame.state.history);
            const resetAdvanced =
              resetId > cutoffRef.current ? advanceCutoff(resetId, localScopeId, localMemberKey) : false;
            const nextSlot: LiveSlotState = {
              scopeId: localScopeId,
              memberKey: localMemberKey,
              session: localSess,
              state: frame.state,
            };
            liveStateRef.current = nextSlot;
            setLiveState(nextSlot);
            handleLiveTransition(frame.state, true);
            if (resetAdvanced) {
              tailPageCursorRef.current = null;
              void drainRawHistory(true);
            }
          } else if (frame.type === 'update') {
            const changes = frame.changes;
            if (!changes) return;
            const resetId =
              'history' in changes && Array.isArray(changes.history)
                ? maxResetEntryId(changes.history)
                : 0;
            const resetAdvanced =
              resetId > cutoffRef.current ? advanceCutoff(resetId, localScopeId, localMemberKey) : false;
            const prevSlot = liveStateRef.current;
            if (
              !prevSlot ||
              prevSlot.scopeId !== localScopeId ||
              prevSlot.memberKey !== localMemberKey ||
              prevSlot.session !== localSess
            ) {
              return;
            }
            const nextState: BotLiveState = { ...prevSlot.state, ...changes };
            const nextSlot: LiveSlotState = {
              scopeId: localScopeId,
              memberKey: localMemberKey,
              session: localSess,
              state: nextState,
            };
            liveStateRef.current = nextSlot;
            setLiveState(nextSlot);
            handleLiveTransition(nextState, false);
            if (resetAdvanced) {
              tailPageCursorRef.current = null;
              void drainRawHistory(true);
            }
          }
        },
      );
      handle = h;
      void h.ready.catch((err: unknown) => {
        if (!isFresh()) return;
        const code = readErrorCode(err);
        if (code === 'BOT_NOT_FOUND') {
          markUnavailable('not_found', localScopeId, localMemberKey, localSess);
          return;
        }
        if (OFFLINE_ERROR_CODES.has(code)) {
          markUnavailable('offline', localScopeId, localMemberKey, localSess);
        }
      });
    } catch (err) {
      if (isFresh()) {
        const code = readErrorCode(err);
        if (code === 'BOT_NOT_FOUND') {
          markUnavailable('not_found', localScopeId, localMemberKey, localSess);
        } else if (OFFLINE_ERROR_CODES.has(code)) {
          markUnavailable('offline', localScopeId, localMemberKey, localSess);
        }
      }
    }

    return () => {
      disposed = true;
      closeHandle();
    };
  }, [
    enabled,
    active,
    online,
    stableMember,
    memberApi,
    scopeId,
    mKey,
    sess,
    advanceCutoff,
    clearOfflineUnavailable,
    drainRawHistory,
    markUnavailable,
    onMemberSettledRef,
  ]);

  return useMemo<MemberPrimarySourceState | null>(() => {
    if (!enabled || !stableMember) return null;

    const matchingUnavailable =
      runtimeUnavailable &&
      runtimeUnavailable.scopeId === scopeId &&
      runtimeUnavailable.memberKey === mKey &&
      runtimeUnavailable.session === sess
        ? runtimeUnavailable.reason
        : null;

    const unavailableReason: 'offline' | 'not_found' | null =
      matchingUnavailable === 'not_found'
        ? 'not_found'
        : !online
          ? 'offline'
          : matchingUnavailable;

    const matchingRaw =
      rawState.scopeId === scopeId && rawState.memberKey === mKey ? rawState : null;

    const matchingLive =
      unavailableReason === null &&
      liveState &&
      liveState.scopeId === scopeId &&
      liveState.memberKey === mKey &&
      liveState.session === sess
        ? liveState.state
        : null;

    return {
      member: stableMember,
      rawEntries: matchingRaw ? matchingRaw.entries : [],
      live: matchingLive,
      clearedThroughEntryId: matchingRaw ? matchingRaw.clearedThroughEntryId : 0,
      unavailableReason,
    };
  }, [enabled, stableMember, runtimeUnavailable, scopeId, mKey, sess, online, rawState, liveState]);
}

export function useDmScopeExecution({
  enabled,
  scopeId,
  members,
  fallbackApi,
  resolveMemberApi,
  active,
  ledgerMessages,
  onMemberSettled,
}: UseDmScopeExecutionOptions): UseDmScopeExecutionResult {
  const onMemberSettledRef = useRef(onMemberSettled);
  onMemberSettledRef.current = onMemberSettled;

  // Deduplicate and bound to the 2 DM participants (preserving canonical scope member order).
  const [member0, member1] = useMemo<[MessageMember | null, MessageMember | null]>(() => {
    if (!enabled) return [null, null];
    const unique: MessageMember[] = [];
    const seen = new Set<string>();
    for (const m of members) {
      const k = memberKeyOf(m);
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(m);
      if (unique.length === 2) break;
    }
    return [unique[0] ?? null, unique[1] ?? null];
  }, [enabled, members]);

  const api0 = resolveApiForMember(member0, enabled, resolveMemberApi, fallbackApi);
  const api1 = resolveApiForMember(member1, enabled, resolveMemberApi, fallbackApi);

  const ledgerId0 = useMemo(
    () => (enabled ? maxLedgerLocalIdForMember(ledgerMessages, member0, scopeId) : 0),
    [enabled, ledgerMessages, member0, scopeId],
  );
  const ledgerId1 = useMemo(
    () => (enabled ? maxLedgerLocalIdForMember(ledgerMessages, member1, scopeId) : 0),
    [enabled, ledgerMessages, member1, scopeId],
  );

  const source0 = useDmMemberPrimarySource({
    enabled: Boolean(enabled && member0),
    scopeId,
    member: member0,
    memberApi: api0,
    active,
    memberLatestLedgerId: ledgerId0,
    onMemberSettledRef,
  });

  const source1 = useDmMemberPrimarySource({
    enabled: Boolean(enabled && member1),
    scopeId,
    member: member1,
    memberApi: api1,
    active,
    memberLatestLedgerId: ledgerId1,
    onMemberSettledRef,
  });

  const sources = useMemo<MemberPrimarySourceState[]>(() => {
    if (!enabled) return [];
    const out: MemberPrimarySourceState[] = [];
    if (source0) out.push(source0);
    if (source1) out.push(source1);
    return out;
  }, [enabled, source0, source1]);

  return { sources };
}
