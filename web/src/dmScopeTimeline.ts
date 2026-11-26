import type { BotLiveState, LiveTool, MessageMember, StoredMessage } from '../../host-core/index.js';
import {
  isBotActivityBusy,
  resolveActiveActivityStartedAt,
  resolveBotActivity,
  type BotActivity,
} from './botActivity.ts';
import {
  chatTurnsWithoutToolOutput,
  entryAttribution,
  mergeHistoryWaitProjection,
  normalizeAttribution,
  parseHistoryEntries,
  type ChatToolCallItem,
  type ChatTurn,
  type ChatTurnBlock,
  type KnownBotSummary,
  type MessageAttribution,
} from './chatTurnModel.ts';

export interface MemberPrimarySourceState {
  member: MessageMember;
  rawEntries: readonly Record<string, unknown>[];
  live: BotLiveState | null;
  clearedThroughEntryId?: number;
  unavailableReason?: 'offline' | 'not_found' | null;
}

export interface DmMemberLiveStatus {
  member: MessageMember;
  isBusy: boolean;
  activity: BotActivity;
  isStreaming: boolean;
  activeToolName: string | null;
  hasThinking: boolean;
  startedAt: number | null;
  failureDetail: string | null;
}

export interface DmExecutionTimelineItem {
  kind: 'execution';
  key: string;
  member: MessageMember;
  turn: ChatTurn;
  silentPass: boolean;
  producedMessageId?: string;
  triggerMessageId?: string;
  isLive: boolean;
}

export interface DmLedgerTimelineItem {
  kind: 'ledger';
  key: string;
  message: StoredMessage;
  ledgerIndex: number;
}

export type DmTimelineItem = DmLedgerTimelineItem | DmExecutionTimelineItem;

export interface DmScopeTimelineResult {
  items: DmTimelineItem[];
  liveStatuses: DmMemberLiveStatus[];
}

export interface MemberBoundaryContext {
  channel: MessageAttribution['channel'];
  scopeId?: string;
  triggerMessageId?: string;
  responseMessageId?: string;
}

export interface MemberDmLiveResolution {
  matched: boolean;
  activity: BotActivity;
  isBusy: boolean;
  isStreaming: boolean;
  activeToolName: string | null;
  hasThinking: boolean;
  startedAt: number | null;
  failureDetail: string | null;
  liveAttribution: MessageAttribution | undefined;
  liveTools: Array<Record<string, unknown>> | undefined;
  liveGeneratingText: string;
  liveGeneratingBlocks: unknown;
  effectiveLive: BotLiveState | null;
  clearedThroughEntryId: number;
  latestBoundary: MemberBoundaryContext;
}

export interface ExtractMemberDmOptions {
  knownBots?: readonly KnownBotSummary[];
  liveResolution?: MemberDmLiveResolution;
}

export interface MergeDmTimelineOptions {
  hasEarlierLedger?: boolean;
}

export interface BuildDmScopeTimelineInput {
  scopeId: string;
  ledgerMessages: readonly StoredMessage[];
  members: readonly MemberPrimarySourceState[];
  knownBots?: readonly KnownBotSummary[];
  hideToolOutput: boolean;
  hasEarlierLedger?: boolean;
}

const IDLE_ACTIVITY: BotActivity = {
  phase: 'idle',
  source: null,
  scopeId: null,
  requestId: null,
  startedAt: null,
};

const VALID_CHANNELS = new Set<MessageAttribution['channel']>(['primary', 'dm', 'room']);
const SILENT_PASS_RE = /^\(?\s*pass\s*\)?\.?$/i;
const LEDGER_PAGINATION_CUTOFF_GRACE_MS = 60_000;
const CODEMODE_WINDOW_BEFORE_MS = 5_000;
const CODEMODE_WINDOW_AFTER_MS = 30_000;

interface TurnSideMetadata {
  responseMessageId?: string;
  nestedSendToScopeById?: Map<string, string>;
}

const turnSideMetadata = new WeakMap<ChatTurn, TurnSideMetadata>();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function isSilentPassText(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === '' || SILENT_PASS_RE.test(trimmed);
}

function numericEntryId(item: Record<string, unknown> | null | undefined): number {
  if (!item) return 0;
  const raw = item.id;
  const id = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(id) ? id : 0;
}

function parseIsoMs(value: string | undefined | null): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function computeEffectiveClearedThrough(source: MemberPrimarySourceState): number {
  let cutoff =
    typeof source.clearedThroughEntryId === 'number' &&
    Number.isSafeInteger(source.clearedThroughEntryId) &&
    source.clearedThroughEntryId > 0
      ? source.clearedThroughEntryId
      : 0;
  for (const item of asArray<Record<string, unknown>>(source.live?.history)) {
    if (item?.kind === 'pi.reset') {
      const id = numericEntryId(item);
      if (id > cutoff) cutoff = id;
    }
  }
  for (const item of source.rawEntries) {
    if (item?.kind === 'pi.reset') {
      const id = numericEntryId(item);
      if (id > cutoff) cutoff = id;
    }
  }
  return cutoff;
}

function resolveEffectiveLive(
  source: MemberPrimarySourceState,
  clearedThroughEntryId: number,
): BotLiveState | null {
  if (source.unavailableReason === 'offline' || source.unavailableReason === 'not_found') {
    return null;
  }
  const live = source.live;
  if (!live) return null;
  if (clearedThroughEntryId <= 0) return live;
  const history = asArray<Record<string, unknown>>(live.history);
  if (history.some((item) => item?.kind === 'pi.reset' && numericEntryId(item) >= clearedThroughEntryId)) {
    return live;
  }
  const lastId =
    typeof live.lastEntryId === 'number' && Number.isFinite(live.lastEntryId)
      ? live.lastEntryId
      : null;
  if (lastId !== null && lastId > clearedThroughEntryId) return live;
  return history.some((item) => numericEntryId(item) > clearedThroughEntryId) ? live : null;
}

function mergeMemberPrimaryEntries(
  source: MemberPrimarySourceState,
  effectiveLive: BotLiveState | null,
  clearedThroughEntryId: number,
): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  const liveAttributionById = new Map<string, unknown>();
  let fallbackIdx = 0;

  const entryKey = (item: Record<string, unknown>): string => {
    if (item.id !== undefined && item.id !== null && String(item.id) !== '') {
      return String(item.id);
    }
    fallbackIdx += 1;
    return `__anon_${fallbackIdx}`;
  };

  for (const item of asArray<Record<string, unknown>>(effectiveLive?.history)) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'pi.reset') continue;
    const id = numericEntryId(item);
    if (clearedThroughEntryId > 0 && id > 0 && id <= clearedThroughEntryId) continue;
    const key = entryKey(item);
    if (item.attribution !== undefined) {
      liveAttributionById.set(key, item.attribution);
    }
    // Read-only DM view: durableWaits is strictly undefined.
    byId.set(key, mergeHistoryWaitProjection(item, undefined, undefined));
  }

  for (const raw of source.rawEntries) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.kind === 'pi.reset') continue;
    const id = numericEntryId(raw);
    if (clearedThroughEntryId > 0 && id > 0 && id <= clearedThroughEntryId) continue;
    const key = entryKey(raw);
    const merged = mergeHistoryWaitProjection(raw, byId.get(key), undefined);
    const data = asRecord(merged.data);
    if (
      data.attribution === undefined &&
      merged.attribution === undefined &&
      liveAttributionById.has(key)
    ) {
      merged.attribution = liveAttributionById.get(key);
    }
    byId.set(key, merged);
  }

  return [...byId.values()].sort((a, b) => numericEntryId(a) - numericEntryId(b));
}

function entryHasAssistantError(item: Record<string, unknown>): boolean {
  const messages = Array.isArray(item.model)
    ? item.model
    : Array.isArray(item.messages)
      ? item.messages
      : [];
  for (const raw of messages) {
    const msg = asRecord(raw);
    if (msg.role !== 'assistant') continue;
    if (msg.stopReason === 'error' || msg.isError === true) return true;
    if (typeof msg.errorMessage === 'string' && msg.errorMessage.trim() !== '') return true;
  }
  return false;
}

function entryHasThinking(item: Record<string, unknown>): boolean {
  const messages = Array.isArray(item.model) ? item.model : [];
  for (const raw of messages) {
    const msg = asRecord(raw);
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const part = asRecord(block);
      if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim() !== '') {
        return true;
      }
    }
  }
  return false;
}

interface ScannedBoundaries {
  byEntryId: Map<number, MemberBoundaryContext>;
  latestBoundary: MemberBoundaryContext;
  latestOpenAttribution: MessageAttribution | undefined;
  latestSegmentHasError: boolean;
  latestSegmentHasThinking: boolean;
}

function readChannel(value: unknown): MessageAttribution['channel'] | undefined {
  return typeof value === 'string' && VALID_CHANNELS.has(value as MessageAttribution['channel'])
    ? (value as MessageAttribution['channel'])
    : undefined;
}

function scanExecutionBoundaries(
  items: readonly Record<string, unknown>[],
  selfBotId: string,
): ScannedBoundaries {
  const byEntryId = new Map<number, MemberBoundaryContext>();
  let current: MemberBoundaryContext = { channel: 'primary' };
  let latestOpenAttribution: MessageAttribution | undefined;
  let latestSegmentHasError = false;
  let latestSegmentHasThinking = false;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const kind = typeof item.kind === 'string' ? item.kind : '';
    if (kind === 'pi.compaction' || kind === 'pi.reset') continue;
    // host.scope-message is a pure import event, never an execution boundary.
    if (kind === 'host.scope-message') continue;

    const id = numericEntryId(item);

    if (kind === 'host.work-trigger') {
      const data = asRecord(item.data);
      const turn = asRecord(data.turn);
      const replyTarget = asRecord(turn.replyTarget);
      const targetKind = readChannel(replyTarget.kind) ?? readChannel(turn.kind);
      if (targetKind === 'primary') {
        current = { channel: 'primary' };
      } else if (targetKind === 'dm' || targetKind === 'room') {
        const targetScopeId =
          readString(replyTarget.scopeId) ??
          readString(turn.scopeId) ??
          readString(data.scopeId);
        const triggerMessageId = readString(turn.triggerMessageId);
        const responseMessageId = readString(turn.responseMessageId);
        current = {
          channel: targetKind,
          ...(targetScopeId ? { scopeId: targetScopeId } : {}),
          ...(triggerMessageId ? { triggerMessageId } : {}),
          ...(responseMessageId ? { responseMessageId } : {}),
        };
      } else {
        const attr = entryAttribution(item, selfBotId);
        if (attr) {
          current =
            attr.channel === 'primary'
              ? { channel: 'primary' }
              : {
                  channel: attr.channel,
                  ...(attr.scopeId ? { scopeId: attr.scopeId } : {}),
                  ...(attr.replyTo ? { triggerMessageId: attr.replyTo } : {}),
                };
        }
      }
      latestOpenAttribution = undefined;
      latestSegmentHasError = false;
      latestSegmentHasThinking = false;
      if (id > 0) byEntryId.set(id, current);
      continue;
    }

    if (kind === 'host.user-message' || kind === 'pi.user') {
      const attr = entryAttribution(item, selfBotId);
      const ch = attr?.channel ?? 'primary';
      current =
        ch === 'primary'
          ? { channel: 'primary' }
          : {
              channel: ch,
              ...(attr?.scopeId ? { scopeId: attr.scopeId } : {}),
              ...(attr?.replyTo ? { triggerMessageId: attr.replyTo } : {}),
            };
      latestOpenAttribution = undefined;
      latestSegmentHasError = false;
      latestSegmentHasThinking = false;
      if (id > 0) byEntryId.set(id, current);
      continue;
    }

    // Assistant, tool-result (both pi.tool-result and pi.tool_result), or other execution entries.
    const attr = entryAttribution(item, selfBotId);
    if (attr) {
      if (attr.channel === 'primary') {
        if (current.channel !== 'primary') {
          latestSegmentHasError = false;
          latestSegmentHasThinking = false;
        }
        current = { channel: 'primary' };
        latestOpenAttribution = attr;
      } else {
        const sameContext =
          current.channel === attr.channel &&
          (attr.scopeId === undefined || current.scopeId === attr.scopeId) &&
          (!attr.replyTo || !current.triggerMessageId || attr.replyTo === current.triggerMessageId);
        if (!sameContext) {
          latestSegmentHasError = false;
          latestSegmentHasThinking = false;
        }
        const nextScopeId = attr.scopeId ?? (sameContext ? current.scopeId : undefined);
        const nextTriggerId = attr.replyTo ?? (sameContext ? current.triggerMessageId : undefined);
        const nextResponseId = sameContext ? current.responseMessageId : undefined;
        current = {
          channel: attr.channel,
          ...(nextScopeId ? { scopeId: nextScopeId } : {}),
          ...(nextTriggerId ? { triggerMessageId: nextTriggerId } : {}),
          ...(nextResponseId ? { responseMessageId: nextResponseId } : {}),
        };
        latestOpenAttribution = attr;
      }
    }

    if (entryHasAssistantError(item)) latestSegmentHasError = true;
    if (entryHasThinking(item)) latestSegmentHasThinking = true;
    if (id > 0) byEntryId.set(id, current);
  }

  return {
    byEntryId,
    latestBoundary: current,
    latestOpenAttribution,
    latestSegmentHasError,
    latestSegmentHasThinking,
  };
}

function resolveActiveLiveToolName(
  tools: readonly LiveTool[],
  isBusy: boolean,
  liveGeneratingText: string,
): string | null {
  if (!isBusy) return null;
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const name = typeof tools[i]?.name === 'string' ? tools[i].name.trim() : '';
    if (name && tools[i]?.status !== 'done') return name;
  }
  const last = tools[tools.length - 1];
  const lastName = typeof last?.name === 'string' ? last.name.trim() : '';
  return lastName && !liveGeneratingText.trim() ? lastName : null;
}

/**
 * Leak-proof 3-tier live gating for a single DM participant BEFORE parseHistoryEntries:
 *   1. live.generation.attribution (authoritative if present)
 *   2. resolveBotActivity(live) when activity.source !== null
 *   3. Legacy Host fallback: latest execution boundary from merged primary entries
 */
export function resolveMemberLiveForDmScope(
  source: MemberPrimarySourceState,
  scopeId: string,
): MemberDmLiveResolution {
  const clearedThroughEntryId = computeEffectiveClearedThrough(source);
  const effectiveLive = resolveEffectiveLive(source, clearedThroughEntryId);
  const mergedItems = mergeMemberPrimaryEntries(source, effectiveLive, clearedThroughEntryId);
  const scanned = scanExecutionBoundaries(mergedItems, source.member.botId);

  if (!effectiveLive) {
    return {
      matched: false,
      activity: IDLE_ACTIVITY,
      isBusy: false,
      isStreaming: false,
      activeToolName: null,
      hasThinking: false,
      startedAt: null,
      failureDetail: null,
      liveAttribution: undefined,
      liveTools: undefined,
      liveGeneratingText: '',
      liveGeneratingBlocks: undefined,
      effectiveLive: null,
      clearedThroughEntryId,
      latestBoundary: scanned.latestBoundary,
    };
  }

  const rawActivity = resolveBotActivity(effectiveLive);
  const liveGenAttr = normalizeAttribution(
    (effectiveLive.generation as { attribution?: unknown } | null | undefined)?.attribution,
  );

  let matched: boolean;
  if (liveGenAttr !== undefined) {
    matched = liveGenAttr.channel === 'dm' && liveGenAttr.scopeId === scopeId;
  } else if (rawActivity.source !== null) {
    matched = rawActivity.source === 'dm' && rawActivity.scopeId === scopeId;
  } else {
    matched = scanned.latestBoundary.channel === 'dm' && scanned.latestBoundary.scopeId === scopeId;
  }

  const parseBusy = Boolean(effectiveLive.busy && matched);
  const isBusy = Boolean(
    parseBusy ||
      (isBotActivityBusy(rawActivity) &&
        matched &&
        rawActivity.source === 'dm' &&
        rawActivity.scopeId === scopeId),
  );

  let failureDetail: string | null = null;
  let failureMatchesScope = false;
  if (!isBusy && rawActivity.phase === 'failed') {
    const rawDetail =
      rawActivity.error?.message?.trim() ||
      rawActivity.error?.code?.trim() ||
      'generation_failed';
    if (rawActivity.source === 'dm' && rawActivity.scopeId === scopeId) {
      failureMatchesScope = true;
      if (!scanned.latestSegmentHasError) {
        failureDetail = rawDetail;
      }
    } else if (
      rawActivity.source === null &&
      scanned.latestBoundary.channel === 'dm' &&
      scanned.latestBoundary.scopeId === scopeId &&
      !scanned.latestSegmentHasError
    ) {
      failureMatchesScope = true;
      failureDetail = rawDetail;
    }
  }

  const stoppedMatchesScope =
    !isBusy &&
    rawActivity.phase === 'stopped' &&
    rawActivity.source === 'dm' &&
    rawActivity.scopeId === scopeId;

  const scopedActivity: BotActivity =
    isBusy || failureMatchesScope || stoppedMatchesScope ? rawActivity : IDLE_ACTIVITY;

  const liveGeneratingText =
    parseBusy && typeof effectiveLive.generation?.text === 'string'
      ? effectiveLive.generation.text
      : '';
  const liveGeneratingBlocks = parseBusy ? effectiveLive.generation?.blocks : undefined;
  const liveTools = parseBusy
    ? asArray<Record<string, unknown>>(effectiveLive.tools)
    : undefined;
  const isStreaming = parseBusy && liveGeneratingText.trim().length > 0;
  const activeToolName = parseBusy
    ? resolveActiveLiveToolName(asArray<LiveTool>(effectiveLive.tools), true, liveGeneratingText)
    : null;
  const hasThinking = Boolean(isBusy && !isStreaming && scanned.latestSegmentHasThinking);
  const startedAt = isBusy ? resolveActiveActivityStartedAt(scopedActivity) : null;

  let liveAttribution: MessageAttribution | undefined;
  if (parseBusy) {
    if (liveGenAttr !== undefined) {
      liveAttribution = liveGenAttr;
    } else if (
      scanned.latestOpenAttribution &&
      scanned.latestOpenAttribution.channel === 'dm' &&
      scanned.latestOpenAttribution.scopeId === scopeId
    ) {
      liveAttribution = scanned.latestOpenAttribution;
    } else {
      const boundaryTrigger =
        scanned.latestBoundary.channel === 'dm' && scanned.latestBoundary.scopeId === scopeId
          ? scanned.latestBoundary.triggerMessageId
          : undefined;
      liveAttribution = {
        kind: 'bot',
        channel: 'dm',
        direction: 'outgoing',
        botId: source.member.botId,
        deviceId: source.member.deviceId,
        scopeId,
        ...(boundaryTrigger ? { replyTo: boundaryTrigger } : {}),
      };
    }
  }

  return {
    matched,
    activity: scopedActivity,
    isBusy,
    isStreaming,
    activeToolName,
    hasThinking,
    startedAt,
    failureDetail,
    liveAttribution,
    liveTools,
    liveGeneratingText,
    liveGeneratingBlocks,
    effectiveLive,
    clearedThroughEntryId,
    latestBoundary: scanned.latestBoundary,
  };
}

function lookupTurnBoundary(
  turn: ChatTurn,
  byEntryId: Map<number, MemberBoundaryContext>,
): MemberBoundaryContext | undefined {
  if (Number.isSafeInteger(turn.entryId) && byEntryId.has(turn.entryId)) {
    return byEntryId.get(turn.entryId);
  }
  const match = /^(\d+)-/.exec(turn.id);
  if (match) {
    const startId = Number(match[1]);
    if (Number.isSafeInteger(startId) && byEntryId.has(startId)) {
      return byEntryId.get(startId);
    }
  }
  return undefined;
}

function collectRawNestedSendToScopes(
  mergedItems: readonly Record<string, unknown>[],
  liveTools: readonly Record<string, unknown>[] | undefined,
): Map<string, string> {
  const scopeByCallId = new Map<string, string>();
  const recordRawArgs = (callId: string | undefined, rawArgs: unknown) => {
    if (!callId || scopeByCallId.has(callId)) return;
    if (typeof rawArgs === 'string') {
      const parsed = parseSendToArgSummary(rawArgs);
      if (parsed.scopeId) scopeByCallId.set(callId, parsed.scopeId);
    } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      const s = readString((rawArgs as Record<string, unknown>).scopeId);
      if (s) scopeByCallId.set(callId, s);
    }
  };

  for (const item of mergedItems) {
    if (!item || typeof item !== 'object') continue;
    const blocks = Array.isArray(item.model)
      ? item.model
      : Array.isArray(item.messages)
        ? item.messages
        : [];
    for (const raw of blocks) {
      const entry = asRecord(raw);
      if (entry.role !== 'toolResult' || entry.toolName !== 'codemode') continue;
      const parentCallId = readString(entry.toolCallId);
      if (Array.isArray(entry.nestedCalls)) {
        for (const value of entry.nestedCalls) {
          const call = asRecord(value);
          if (readString(call.name) !== 'send_to') continue;
          const childId = readString(call.callId);
          recordRawArgs(childId, call.argsPreview ?? call.args);
        }
      }
      const details = asRecord(entry.details);
      if (Array.isArray(details.calls) && parentCallId) {
        for (const value of details.calls) {
          const call = asRecord(value);
          if (readString(call.name) !== 'send_to') continue;
          if (!Number.isSafeInteger(call.id) || (call.id as number) < 0) continue;
          recordRawArgs(`${parentCallId}/c${call.id as number}`, call.args);
        }
      }
    }
  }

  for (const rawSlot of liveTools ?? []) {
    const slot = asRecord(rawSlot);
    if (!readString(slot.parentCallId) || readString(slot.name) !== 'send_to') continue;
    recordRawArgs(readString(slot.callId), slot.argsPreview ?? slot.arguments);
  }

  return scopeByCallId;
}

/**
 * Parse-then-filter extraction of a member Bot's DM execution turns for `scopeId`.
 * Strictly keeps ONLY assistant turns whose effective channel is `'dm'` and effective
 * scopeId equals `scopeId` (never leaking primary, room, primary-resumed, or other DMs).
 */
export function extractMemberDmExecutionTurns(
  source: MemberPrimarySourceState,
  scopeId: string,
  options?: ExtractMemberDmOptions,
): ChatTurn[] {
  const liveRes = options?.liveResolution ?? resolveMemberLiveForDmScope(source, scopeId);
  const mergedItems = mergeMemberPrimaryEntries(
    source,
    liveRes.effectiveLive,
    liveRes.clearedThroughEntryId,
  );
  const scanned = scanExecutionBoundaries(mergedItems, source.member.botId);

  const parseBusy = Boolean(liveRes.effectiveLive?.busy && liveRes.matched);
  const rawNestedSendToScopeById = collectRawNestedSendToScopes(
    mergedItems,
    parseBusy ? liveRes.liveTools : undefined,
  );
  const parsedTurns = parseHistoryEntries(mergedItems, liveRes.clearedThroughEntryId, {
    selfBotId: source.member.botId,
    knownBots: options?.knownBots,
    durableWaits: undefined,
    isBusy: parseBusy,
    liveTools: parseBusy ? liveRes.liveTools : undefined,
    liveGeneratingText: parseBusy ? liveRes.liveGeneratingText : '',
    liveGeneratingBlocks: parseBusy ? liveRes.liveGeneratingBlocks : undefined,
    liveAttribution: parseBusy ? liveRes.liveAttribution : undefined,
  });

  const out: ChatTurn[] = [];
  for (const turn of parsedTurns) {
    // Rule 1: Only assistant execution turns (never primary user messages or incoming scope-messages).
    if (turn.role !== 'assistant') continue;

    const boundary =
      lookupTurnBoundary(turn, scanned.byEntryId) ??
      (turn.id === 'live-assistant' && liveRes.matched ? scanned.latestBoundary : undefined);

    const attr = turn.attribution;
    const effectiveChannel: MessageAttribution['channel'] =
      attr !== undefined
        ? attr.channel
        : boundary?.channel ?? (turn.dmChannel ? 'dm' : 'primary');

    // Rule 2: Strictly DM channel (excludes primary, room, host triggers, and primary-resumed replies).
    if (effectiveChannel !== 'dm') continue;

    const effectiveScopeId =
      attr?.scopeId ??
      (boundary?.channel === 'dm' ? boundary.scopeId : undefined);

    // Rule 3: Strictly currentScopeId (excludes other DM scopes and unproven legacy entries).
    if (effectiveScopeId !== scopeId) continue;

    const hydratedAttr: MessageAttribution = attr
      ? {
          ...attr,
          scopeId,
          ...(attr.botId ? {} : { botId: source.member.botId }),
          ...(attr.deviceId ? {} : { deviceId: source.member.deviceId }),
          ...(attr.replyTo || !boundary?.triggerMessageId
            ? {}
            : { replyTo: boundary.triggerMessageId }),
        }
      : {
          kind: 'bot',
          channel: 'dm',
          direction: 'outgoing',
          botId: source.member.botId,
          deviceId: source.member.deviceId,
          scopeId,
          ...(boundary?.triggerMessageId ? { replyTo: boundary.triggerMessageId } : {}),
        };

    const hydratedTurn: ChatTurn = {
      ...turn,
      attribution: hydratedAttr,
    };
    let turnNestedScopes: Map<string, string> | undefined;
    if (rawNestedSendToScopeById.size > 0) {
      for (const tool of collectTurnTools(turn)) {
        for (const child of tool.children ?? []) {
          const childScope = rawNestedSendToScopeById.get(child.id);
          if (childScope) {
            (turnNestedScopes ??= new Map<string, string>()).set(child.id, childScope);
          }
        }
      }
    }
    if (boundary?.responseMessageId || turnNestedScopes) {
      turnSideMetadata.set(hydratedTurn, {
        ...(boundary?.responseMessageId ? { responseMessageId: boundary.responseMessageId } : {}),
        ...(turnNestedScopes ? { nestedSendToScopeById: turnNestedScopes } : {}),
      });
    }
    out.push(hydratedTurn);
  }

  return out;
}

interface ParsedArgSummary {
  scopeId?: string;
  text?: string;
  fileCount?: number;
  silentPass?: boolean;
  truncatedText?: boolean;
}

function unescapeJsonFragment(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function parseSendToArgSummary(argSummary: string | undefined): ParsedArgSummary {
  if (typeof argSummary !== 'string') return {};
  const trimmed = argSummary.trim();
  if (!trimmed) return {};
  if (SILENT_PASS_RE.test(trimmed)) {
    return { silentPass: true };
  }
  if (trimmed.startsWith('→')) {
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const snippet = trimmed.slice(colonIdx + 1).trim();
      if (SILENT_PASS_RE.test(snippet)) return { silentPass: true };
    }
    return {};
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = asRecord(JSON.parse(trimmed));
      const scopeId = readString(parsed.scopeId);
      const files = Array.isArray(parsed.files) ? parsed.files.length : 0;
      const rawText = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      const silentPass = files === 0 && typeof parsed.text === 'string' && isSilentPassText(rawText);
      return {
        ...(scopeId ? { scopeId } : {}),
        ...(rawText && !silentPass ? { text: rawText } : {}),
        ...(files > 0 ? { fileCount: files } : {}),
        ...(silentPass ? { silentPass: true } : {}),
      };
    } catch {
      // Truncated JSON preview from host-core/tool-call-summary.js (1024-unit cap ending in '…').
      const out: ParsedArgSummary = {};
      const scopeMatch = /"scopeId"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(trimmed);
      if (scopeMatch) {
        const s = unescapeJsonFragment(scopeMatch[1]).trim();
        if (s) out.scopeId = s;
      }
      const filesMatch = /"files"\s*:\s*\[([^\]]*)/.exec(trimmed);
      const hasFiles = Boolean(filesMatch && filesMatch[1].trim().length > 0);
      if (hasFiles) out.fileCount = 1;
      const textClosed = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(trimmed);
      if (textClosed) {
        const t = unescapeJsonFragment(textClosed[1]).trim();
        if (!hasFiles && isSilentPassText(t)) out.silentPass = true;
        else if (t) out.text = t;
      } else {
        const textPartial = /"text"\s*:\s*"((?:\\.|[^"\\])*)/.exec(trimmed);
        if (textPartial) {
          let raw = textPartial[1];
          let truncated = false;
          if (raw.endsWith('…')) {
            raw = raw.slice(0, -1);
            truncated = true;
          }
          const t = unescapeJsonFragment(raw).trim();
          if (t) {
            out.text = t;
            out.truncatedText = truncated || trimmed.endsWith('…');
          }
        }
      }
      return out;
    }
  }
  return {};
}

interface ExtractedSendToInfo {
  tool: ChatToolCallItem;
  isNested: boolean;
  isSuccess: boolean;
  isInFlight: boolean;
  isError: boolean;
  targetScopeId?: string;
  scopeKind?: 'dm' | 'room';
  targetsCurrentScope: boolean;
  messageId?: string;
  text?: string;
  truncatedText: boolean;
  fileCount: number;
  silentPass: boolean;
}

function inspectSendToTool(
  tool: ChatToolCallItem,
  currentScopeId: string,
  isNested: boolean,
  recordedScopeId?: string,
): ExtractedSendToInfo {
  const isInFlight = tool.status === 'running';
  const isError =
    tool.status === 'error' ||
    tool.status === 'cancelled' ||
    tool.status === 'interrupted' ||
    tool.outcome === 'error' ||
    tool.outcome === 'cancelled' ||
    tool.outcome === 'interrupted';
  const isSuccess = !isInFlight && !isError && tool.status === 'done';

  let targetScopeId: string | undefined =
    readString((tool.sendTo as Record<string, unknown> | undefined)?.scopeId) ?? recordedScopeId;
  let scopeKind: 'dm' | 'room' | undefined = tool.sendTo?.scopeKind;
  let messageId: string | undefined;
  let text: string | undefined = tool.sendTo?.text?.trim() || undefined;
  let truncatedText = false;
  let fileCount = tool.sendTo?.fileCount ?? 0;
  let silentPass = Boolean(tool.sendTo?.silentPass);

  if (tool.args) {
    const argScopeId = readString(tool.args.scopeId);
    if (argScopeId) targetScopeId = argScopeId;
    const files = Array.isArray(tool.args.files) ? tool.args.files.length : 0;
    if (files > 0) fileCount = Math.max(fileCount, files);
    if (typeof tool.args.text === 'string') {
      const rawText = tool.args.text.trim();
      if (files === 0 && isSilentPassText(rawText)) {
        silentPass = true;
        text = undefined;
      } else if (rawText) {
        text = rawText;
        silentPass = false;
      }
    }
  }

  if (isNested || (!tool.args && !tool.sendTo)) {
    const summary = parseSendToArgSummary(tool.argSummary);
    if (!targetScopeId && summary.scopeId) targetScopeId = summary.scopeId;
    if (summary.fileCount && summary.fileCount > 0) {
      fileCount = Math.max(fileCount, summary.fileCount);
    }
    if (summary.silentPass && !text) {
      silentPass = true;
    } else if (!text && summary.text) {
      text = summary.text;
      truncatedText = Boolean(summary.truncatedText);
      silentPass = false;
    }
  }

  if (tool.output) {
    try {
      const parsed = asRecord(JSON.parse(tool.output));
      const outScopeId = readString(parsed.scopeId);
      if (outScopeId) targetScopeId = outScopeId;
      if (parsed.scopeKind === 'dm' || parsed.scopeKind === 'room') {
        scopeKind = parsed.scopeKind;
      }
      if (parsed.status === 'silent_pass') {
        silentPass = true;
        text = undefined;
      } else if (parsed.status === 'turn_cap_reached') {
        // Nothing was published.
        messageId = undefined;
      } else {
        const outMsgId = readString(parsed.messageId);
        if (outMsgId && (parsed.status === 'stored' || parsed.status === undefined)) {
          messageId = outMsgId;
        }
        if (!text && !silentPass) {
          const preview = readString(parsed.previewText);
          if (preview) text = preview.trim();
        }
        if (fileCount === 0 && Array.isArray(parsed.files) && parsed.files.length > 0) {
          fileCount = parsed.files.length;
        }
      }
    } catch {
      // Ignore non-JSON tool output.
    }
  }

  const targetsCurrentScope =
    targetScopeId !== undefined
      ? targetScopeId === currentScopeId
      : scopeKind !== 'room';

  return {
    tool,
    isNested,
    isSuccess,
    isInFlight,
    isError,
    targetScopeId,
    scopeKind,
    targetsCurrentScope,
    messageId,
    text,
    truncatedText,
    fileCount,
    silentPass,
  };
}

function extractMessageIdsFromCodemodeOutput(
  output: string | undefined,
  currentScopeId: string,
  candidateLedgerIds: ReadonlySet<string>,
): string[] {
  if (!output) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const addId = (id: string | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    found.push(id);
  };

  const scanJsonValue = (val: unknown, depth: number) => {
    if (depth > 4 || val === null || val === undefined || typeof val !== 'object') return;
    if (Array.isArray(val)) {
      for (const item of val) scanJsonValue(item, depth + 1);
      return;
    }
    const obj = val as Record<string, unknown>;
    const msgId = readString(obj.messageId);
    if (msgId) {
      const objScopeId = readString(obj.scopeId);
      const objStatus = typeof obj.status === 'string' ? obj.status : undefined;
      const scopeOk = objScopeId === undefined || objScopeId === currentScopeId;
      const statusOk = objStatus === undefined || objStatus === 'stored';
      if (scopeOk && statusOk) addId(msgId);
    }
    for (const child of Object.values(obj)) {
      if (child && typeof child === 'object') scanJsonValue(child, depth + 1);
    }
  };

  try {
    scanJsonValue(JSON.parse(output), 0);
  } catch {
    // Also inspect free-form console output against known ledger message IDs authored by this member.
    for (const id of candidateLedgerIds) {
      if (id.length > 0 && output.includes(id)) {
        addId(id);
      }
    }
  }
  return found;
}

function isLedgerAuthoredByMember(
  msg: StoredMessage,
  member: MessageMember,
  scopeId: string,
): boolean {
  const env = msg.message;
  if (env.scopeId && env.scopeId !== scopeId) return false;
  if (env.author.kind !== 'bot') return false;
  if (env.author.botId !== member.botId) return false;
  if (member.deviceId && env.sourceDeviceId && env.sourceDeviceId !== member.deviceId) return false;
  return true;
}

function computeTurnStartEndMs(turn: ChatTurn): { startMs: number | null; endMs: number | null } {
  const startCandidate =
    turn.startedAt ??
    turn.timestamp ??
    parseIsoMs(turn.createdAt ?? turn.attribution?.createdAt) ??
    null;
  const startMs =
    typeof startCandidate === 'number' && Number.isFinite(startCandidate) && startCandidate > 0
      ? startCandidate
      : null;
  if (startMs === null) return { startMs: null, endMs: null };
  const fromDuration =
    typeof turn.durationMs === 'number' && Number.isFinite(turn.durationMs) && turn.durationMs > 0
      ? startMs + turn.durationMs
      : startMs;
  const tsEnd =
    typeof turn.timestamp === 'number' && Number.isFinite(turn.timestamp) && turn.timestamp > 0
      ? turn.timestamp
      : startMs;
  return { startMs, endMs: Math.max(startMs, fromDuration, tsEnd) };
}

function isTurnLive(turn: ChatTurn): boolean {
  if (turn.isStreaming === true) return true;
  for (const tool of turn.tools ?? []) {
    if (tool.status === 'running') return true;
    for (const child of tool.children ?? []) {
      if (child.status === 'running') return true;
    }
  }
  return false;
}

function collectTurnTools(turn: ChatTurn): ChatToolCallItem[] {
  if (turn.tools && turn.tools.length > 0) return turn.tools;
  if (!turn.blocks) return [];
  return turn.blocks.flatMap((block) => (block.kind === 'tools' ? block.tools : []));
}

interface AnalyzedTurn {
  turn: ChatTurn;
  index: number;
  isLive: boolean;
  topSendTos: ExtractedSendToInfo[];
  nestedSendTos: ExtractedSendToInfo[];
  codemodeTools: ChatToolCallItem[];
  codemodeOutputMessageIds: string[];
  hasEligibleSameScopeSend: boolean;
  allSameScopeSendsHaveExplicitMessageId: boolean;
  hasCodemodeTimeFallback: boolean;
  isSilentPassOnly: boolean;
  matchedLedgerIndex: number;
  matchedMessageIds: Set<string>;
}

function ledgerMatchesSendText(ledgerText: string, info: ExtractedSendToInfo): boolean {
  if (!info.text) return false;
  const expected = info.text.trim();
  if (!expected) return false;
  if (ledgerText === expected) return true;
  if (info.fileCount > 0 && ledgerText.startsWith(expected)) return true;
  if (info.truncatedText && expected.length >= 16 && ledgerText.startsWith(expected)) return true;
  return false;
}

/**
 * Matches DM execution turns 1-to-1 against `ledgerMessages` authored by `member` and:
 * - Strips top-level succeeded non-pass `send_to` targeting `scopeId` once matched to `M_j`
 *   (preserving running, errored, cross-scope, and not-yet-polled `send_to`).
 * - Keeps `codemode` cards intact while neutralizing `child.sendTo` on matched redundant
 *   same-scope succeeded nested `send_to` children so `BotDmFoldCard` does not duplicate `M_j`.
 * - Suppresses plain text blocks literally identical (`trim()`) to `M_j.message.text.trim()`.
 * - Tags silent-pass turns (`send_to("(pass)")`, no ledger message) with `silentPass: true`.
 */
export function stripRedundantDmSendTo(
  turns: readonly ChatTurn[],
  member: MessageMember,
  scopeId: string,
  ledgerMessages: readonly StoredMessage[],
): DmExecutionTimelineItem[] {
  const memberLedgerIndices: number[] = [];
  const ledgerIdxByMessageId = new Map<string, number>();
  const memberLedgerMessageIds = new Set<string>();
  const ledgerCreatedMs: (number | null)[] = [];

  for (let i = 0; i < ledgerMessages.length; i += 1) {
    const msg = ledgerMessages[i];
    ledgerCreatedMs.push(parseIsoMs(msg.message.createdAt) ?? parseIsoMs(msg.storedAt));
    if (isLedgerAuthoredByMember(msg, member, scopeId)) {
      memberLedgerIndices.push(i);
      if (msg.message.messageId) {
        ledgerIdxByMessageId.set(msg.message.messageId, i);
        memberLedgerMessageIds.add(msg.message.messageId);
      }
    }
  }

  const analyzed: AnalyzedTurn[] = turns.map((turn, index) => {
    const tools = collectTurnTools(turn);
    const side = turnSideMetadata.get(turn);
    const topSendTos: ExtractedSendToInfo[] = [];
    const nestedSendTos: ExtractedSendToInfo[] = [];
    const codemodeTools: ChatToolCallItem[] = [];
    const codemodeOutputMessageIds: string[] = [];

    for (const tool of tools) {
      if (tool.name === 'send_to' && !tool.parentCallId) {
        topSendTos.push(inspectSendToTool(tool, scopeId, false));
      } else if (tool.name === 'codemode') {
        codemodeTools.push(tool);
        if (tool.status === 'done' && tool.outcome !== 'error' && tool.outcome !== 'cancelled' && tool.outcome !== 'interrupted') {
          for (const id of extractMessageIdsFromCodemodeOutput(
            tool.output,
            scopeId,
            memberLedgerMessageIds,
          )) {
            if (!codemodeOutputMessageIds.includes(id)) codemodeOutputMessageIds.push(id);
          }
        }
        for (const child of tool.children ?? []) {
          if (child.name === 'send_to') {
            nestedSendTos.push(
              inspectSendToTool(child, scopeId, true, side?.nestedSendToScopeById?.get(child.id)),
            );
          }
        }
      }
    }

    const sameScopeSucceededNonPass = [...topSendTos, ...nestedSendTos].filter(
      (s) => s.targetsCurrentScope && s.isSuccess && !s.silentPass,
    );
    const sameScopeSucceededPass = [...topSendTos, ...nestedSendTos].filter(
      (s) => s.targetsCurrentScope && s.isSuccess && s.silentPass,
    );
    const hasSettledOpaqueCodemode = codemodeTools.some(
      (cm) =>
        cm.status === 'done' &&
        cm.outcome !== 'error' &&
        cm.outcome !== 'cancelled' &&
        cm.outcome !== 'interrupted' &&
        (cm.nestedCallsTruncated === true || cm.children === undefined),
    );
    const sameScopeNestedCodemodeSends = nestedSendTos.filter(
      (s) => s.targetsCurrentScope && s.isSuccess && !s.silentPass,
    );
    const hasSameScopeNestedCodemodeSend = sameScopeNestedCodemodeSends.length > 0;

    const hasEligibleSameScopeSend =
      sameScopeSucceededNonPass.length > 0 ||
      codemodeOutputMessageIds.length > 0 ||
      hasSettledOpaqueCodemode;

    const allSameScopeSendsHaveExplicitMessageId =
      sameScopeSucceededNonPass.length > 0 &&
      !hasSettledOpaqueCodemode &&
      !hasSameScopeNestedCodemodeSend &&
      sameScopeSucceededNonPass.every((s) => s.messageId !== undefined);

    const hasCodemodeTimeFallback =
      hasSettledOpaqueCodemode ||
      sameScopeNestedCodemodeSends.some(
        (s) => s.targetScopeId === scopeId || s.text === undefined || s.truncatedText,
      );

    const hasAnySameScopeNonPass = [...topSendTos, ...nestedSendTos].some(
      (s) => s.targetsCurrentScope && !s.silentPass,
    );
    const isSilentPassOnly =
      sameScopeSucceededPass.length > 0 &&
      !hasAnySameScopeNonPass &&
      codemodeOutputMessageIds.length === 0;

    return {
      turn,
      index,
      isLive: isTurnLive(turn),
      topSendTos,
      nestedSendTos,
      codemodeTools,
      codemodeOutputMessageIds,
      hasEligibleSameScopeSend,
      allSameScopeSendsHaveExplicitMessageId,
      hasCodemodeTimeFallback,
      isSilentPassOnly,
      matchedLedgerIndex: -1,
      matchedMessageIds: new Set<string>(),
    };
  });

  const claimedLedger = new Set<number>();

  // Pass 1: Exact messageId from top-level send_to JSON output (status === 'stored') or codemode output.
  for (const item of analyzed) {
    const candidateIds: string[] = [];
    for (const s of item.topSendTos) {
      if (s.targetsCurrentScope && s.isSuccess && !s.silentPass && s.messageId) {
        candidateIds.push(s.messageId);
      }
    }
    for (const id of item.codemodeOutputMessageIds) {
      candidateIds.push(id);
    }
    for (const msgId of candidateIds) {
      const idx = ledgerIdxByMessageId.get(msgId);
      if (idx === undefined || claimedLedger.has(idx)) continue;
      claimedLedger.add(idx);
      item.matchedMessageIds.add(msgId);
      if (item.matchedLedgerIndex === -1 || idx < item.matchedLedgerIndex) {
        item.matchedLedgerIndex = idx;
      }
    }
  }

  // Pass 2: Unclaimed M_j authored by member with M_j.message.replyTo === T.attribution?.replyTo (or responseMessageId).
  for (const item of analyzed) {
    if (item.matchedLedgerIndex !== -1) continue;
    if (!item.hasEligibleSameScopeSend || item.allSameScopeSendsHaveExplicitMessageId) continue;

    const side = turnSideMetadata.get(item.turn);
    const replyCandidates: string[] = [];
    if (item.turn.attribution?.replyTo) replyCandidates.push(item.turn.attribution.replyTo);
    if (side?.responseMessageId && !replyCandidates.includes(side.responseMessageId)) {
      replyCandidates.push(side.responseMessageId);
    }
    if (replyCandidates.length === 0) continue;

    const matchingIndices = memberLedgerIndices.filter((idx) => {
      if (claimedLedger.has(idx)) return false;
      const replyTo = ledgerMessages[idx].message.replyTo;
      return typeof replyTo === 'string' && replyCandidates.includes(replyTo);
    });
    if (matchingIndices.length === 0) continue;

    const sendCandidates = [...item.topSendTos, ...item.nestedSendTos].filter(
      (s) => s.targetsCurrentScope && s.isSuccess && !s.silentPass,
    );
    let chosen = matchingIndices.find((idx) => {
      const ledgerText = ledgerMessages[idx].message.text.trim();
      return sendCandidates.some((s) => ledgerMatchesSendText(ledgerText, s));
    });
    if (chosen === undefined) {
      const allUnconfirmedTextMismatch =
        sendCandidates.length > 0 &&
        sendCandidates.every(
          (s) =>
            s.targetScopeId === undefined &&
            s.text !== undefined &&
            !s.truncatedText,
        );
      if (!allUnconfirmedTextMismatch) {
        chosen = matchingIndices[0];
      }
    }
    if (chosen === undefined) continue;
    claimedLedger.add(chosen);
    item.matchedLedgerIndex = chosen;
    const chosenId = ledgerMessages[chosen].message.messageId;
    if (chosenId) item.matchedMessageIds.add(chosenId);
  }

  // Pass 3a: Unclaimed M_j authored by member whose trimmed text equals sendTo.text.
  for (const item of analyzed) {
    if (item.matchedLedgerIndex !== -1) continue;
    if (!item.hasEligibleSameScopeSend || item.allSameScopeSendsHaveExplicitMessageId) continue;

    const sendCandidates = [...item.topSendTos, ...item.nestedSendTos].filter(
      (s) => s.targetsCurrentScope && s.isSuccess && !s.silentPass && Boolean(s.text),
    );
    if (sendCandidates.length === 0) continue;

    const chosen = memberLedgerIndices.find((idx) => {
      if (claimedLedger.has(idx)) return false;
      const ledgerText = ledgerMessages[idx].message.text.trim();
      return sendCandidates.some((s) => ledgerMatchesSendText(ledgerText, s));
    });
    if (chosen !== undefined) {
      claimedLedger.add(chosen);
      item.matchedLedgerIndex = chosen;
      const chosenId = ledgerMessages[chosen].message.messageId;
      if (chosenId) item.matchedMessageIds.add(chosenId);
    }
  }

  // Pass 3b: Codemode nested send_to time-window match ([startedAt - 5s, endAt + 30s]) when child output is not persisted.
  for (const item of analyzed) {
    if (item.matchedLedgerIndex !== -1) continue;
    if (!item.hasCodemodeTimeFallback || item.allSameScopeSendsHaveExplicitMessageId) continue;

    const { startMs, endMs } = computeTurnStartEndMs(item.turn);
    if (startMs === null || endMs === null) continue;
    const minMs = startMs - CODEMODE_WINDOW_BEFORE_MS;
    const maxMs = endMs + CODEMODE_WINDOW_AFTER_MS;

    let bestIdx = -1;
    let bestDist = Infinity;
    for (const idx of memberLedgerIndices) {
      if (claimedLedger.has(idx)) continue;
      const msgMs = ledgerCreatedMs[idx];
      if (msgMs === null || msgMs < minMs || msgMs > maxMs) continue;
      const dist = Math.abs(msgMs - endMs);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    }
    if (bestIdx !== -1) {
      claimedLedger.add(bestIdx);
      item.matchedLedgerIndex = bestIdx;
      const chosenId = ledgerMessages[bestIdx].message.messageId;
      if (chosenId) item.matchedMessageIds.add(chosenId);
    }
  }

  // Build stripped DmExecutionTimelineItem[] without mutating input turns/tools/blocks.
  return analyzed.map((item) => {
    const matchedLedger =
      item.matchedLedgerIndex !== -1 ? ledgerMessages[item.matchedLedgerIndex] : undefined;
    const producedMessageId = matchedLedger?.message.messageId || undefined;
    const silentPass = producedMessageId === undefined && item.isSilentPassOnly;

    const topInfoByTool = new Map<ChatToolCallItem, ExtractedSendToInfo>(
      item.topSendTos.map((s) => [s.tool, s]),
    );
    const nestedInfoByTool = new Map<ChatToolCallItem, ExtractedSendToInfo>(
      item.nestedSendTos.map((s) => [s.tool, s]),
    );

    const shouldStripTopTool = (tool: ChatToolCallItem): boolean => {
      const info = topInfoByTool.get(tool);
      if (!info) return false;
      if (!info.targetsCurrentScope || !info.isSuccess) return false;
      if (info.silentPass) {
        return silentPass;
      }
      if (producedMessageId === undefined) return false;
      // If this specific send_to carried an explicit messageId, strip it only when that message is in the ledger.
      if (info.messageId !== undefined) {
        return item.matchedMessageIds.has(info.messageId);
      }
      return true;
    };

    const matchedLedgerTexts = new Set<string>();
    if (matchedLedger) {
      const t = matchedLedger.message.text.trim();
      if (t) matchedLedgerTexts.add(t);
    }
    for (const msgId of item.matchedMessageIds) {
      const idx = ledgerIdxByMessageId.get(msgId);
      if (idx !== undefined) {
        const t = ledgerMessages[idx].message.text.trim();
        if (t) matchedLedgerTexts.add(t);
      }
    }

    const shouldNeutralizeNestedSendTo = (info: ExtractedSendToInfo): boolean => {
      if (!info.targetsCurrentScope || !info.isSuccess) return false;
      if (info.silentPass) return silentPass;
      if (producedMessageId === undefined) return false;
      // If explicit scopeId matches currentScopeId, neutralize cleanly.
      if (info.targetScopeId === scopeId) return true;
      // When scopeId was omitted/overwritten in argSummary (e.g. formatted "→ Peer: ..."),
      // require text match against the claimed ledger message(s) whenever text is known so
      // cross-scope nested send_to calls to a third Bot stay intact.
      if (info.text && matchedLedgerTexts.size > 0) {
        for (const ledgerText of matchedLedgerTexts) {
          if (ledgerMatchesSendText(ledgerText, info)) return true;
        }
        return false;
      }
      return true;
    };

    const transformTool = (tool: ChatToolCallItem): ChatToolCallItem | null => {
      if (shouldStripTopTool(tool)) return null;
      if (
        tool.name === 'codemode' &&
        (producedMessageId !== undefined || silentPass) &&
        tool.children &&
        tool.children.length > 0
      ) {
        let changed = false;
        const nextChildren = tool.children.map((child) => {
          const info = nestedInfoByTool.get(child);
          if (info && child.sendTo !== undefined && shouldNeutralizeNestedSendTo(info)) {
            changed = true;
            const { sendTo: _strippedSendTo, ...rest } = child;
            return rest;
          }
          return child;
        });
        return changed ? { ...tool, children: nextChildren } : tool;
      }
      return tool;
    };

    const mappedToolCache = new Map<ChatToolCallItem, ChatToolCallItem | null>();
    const mapToolMemo = (tool: ChatToolCallItem): ChatToolCallItem | null => {
      if (mappedToolCache.has(tool)) return mappedToolCache.get(tool) ?? null;
      const mapped = transformTool(tool);
      mappedToolCache.set(tool, mapped);
      return mapped;
    };

    let nextBlocks: ChatTurnBlock[] | undefined;
    let nextText = item.turn.text;

    if (item.turn.blocks) {
      const filteredBlocks: ChatTurnBlock[] = [];
      for (const block of item.turn.blocks) {
        if (block.kind === 'text') {
          if (matchedLedgerTexts.size > 0 && matchedLedgerTexts.has(block.text.trim())) {
            continue;
          }
          filteredBlocks.push(block);
        } else if (block.kind === 'tools') {
          const keptTools: ChatToolCallItem[] = [];
          for (const tool of block.tools) {
            const mapped = mapToolMemo(tool);
            if (mapped !== null) keptTools.push(mapped);
          }
          if (keptTools.length > 0) {
            filteredBlocks.push({ ...block, tools: keptTools });
          }
        } else {
          filteredBlocks.push(block);
        }
      }
      nextBlocks = filteredBlocks.length > 0 ? filteredBlocks : undefined;
      nextText = filteredBlocks
        .filter((b): b is Extract<ChatTurnBlock, { kind: 'text' }> => b.kind === 'text')
        .map((b) => b.text)
        .join('\n\n')
        .trim();
    } else if (matchedLedgerTexts.size > 0 && matchedLedgerTexts.has(item.turn.text.trim())) {
      nextText = '';
    }

    const rawTopTools =
      item.turn.tools ??
      (item.turn.blocks
        ? item.turn.blocks.flatMap((block) => (block.kind === 'tools' ? block.tools : []))
        : []);
    const nextTools: ChatToolCallItem[] = [];
    for (const tool of rawTopTools) {
      const mapped = mapToolMemo(tool);
      if (mapped !== null) nextTools.push(mapped);
    }

    const nextTurn: ChatTurn = {
      ...item.turn,
      text: nextText,
      blocks: nextBlocks,
      tools: nextTools.length > 0 ? nextTools : undefined,
      toolSummary: nextTools.length > 0 ? nextTools.map((t) => t.name) : undefined,
    };
    const side = turnSideMetadata.get(item.turn);
    if (side) turnSideMetadata.set(nextTurn, side);

    const triggerMessageId = item.turn.attribution?.replyTo;
    return {
      kind: 'execution',
      key: `exec:${member.deviceId}:${member.botId}:${item.turn.id}`,
      member,
      turn: nextTurn,
      silentPass,
      ...(producedMessageId !== undefined ? { producedMessageId } : {}),
      ...(triggerMessageId !== undefined ? { triggerMessageId } : {}),
      isLive: item.isLive,
    };
  });
}

function isExecutionItemVisible(exec: DmExecutionTimelineItem): boolean {
  if (exec.silentPass) return true;
  const { turn } = exec;
  if (turn.text.trim().length > 0) return true;
  if (turn.thinking && turn.thinking.trim().length > 0) return true;
  if (turn.error && turn.error.trim().length > 0) return true;
  if (turn.tools && turn.tools.length > 0) return true;
  if (turn.blocks && turn.blocks.length > 0) return true;
  return false;
}

function executionAnchorMs(exec: DmExecutionTimelineItem): number | null {
  const { turn } = exec;
  if (typeof turn.startedAt === 'number' && Number.isFinite(turn.startedAt) && turn.startedAt > 0) {
    return turn.startedAt;
  }
  if (typeof turn.timestamp === 'number' && Number.isFinite(turn.timestamp) && turn.timestamp > 0) {
    return turn.timestamp;
  }
  return parseIsoMs(turn.createdAt ?? turn.attribution?.createdAt);
}

function compareExecutions(a: DmExecutionTimelineItem, b: DmExecutionTimelineItem): number {
  const aTs = executionAnchorMs(a);
  const bTs = executionAnchorMs(b);
  if (aTs !== null && bTs !== null && aTs !== bTs) return aTs - bTs;
  if (aTs !== null && bTs === null) return -1;
  if (aTs === null && bTs !== null) return 1;
  if (a.turn.entryId !== b.turn.entryId) return a.turn.entryId - b.turn.entryId;
  return a.key.localeCompare(b.key);
}

/**
 * Causally and chronologically merges canonical `scopeHistory` ledger messages with
 * per-member DM execution items, immune to cross-device clock skew:
 *   1. Matched `producedMessageId` -> `beforeSlot[j]` (immediately before M_j)
 *   2. Live execution (`isLive`) -> `tail`
 *   3. Matched `triggerMessageId` / `replyTo` -> `afterSlot[k]` (immediately after M_k)
 *   4. Unanchored -> hide if `hasEarlierLedger && anchorTs < oldestLedgerMs - 60_000`,
 *      otherwise insert by timestamp relative to ledger `createdAt` (or `tail` if empty).
 * Drops empty execution items (no remaining text, thinking, tools, error, or visible silent-pass).
 */
export function mergeDmLedgerAndExecutions(
  ledgerMessages: readonly StoredMessage[],
  executions: readonly DmExecutionTimelineItem[],
  options?: MergeDmTimelineOptions,
): DmTimelineItem[] {
  const n = ledgerMessages.length;
  const ledgerIdxByMessageId = new Map<string, number>();
  const ledgerTimestamps: (number | null)[] = new Array(n);
  let oldestLedgerMs: number | null = null;

  for (let i = 0; i < n; i += 1) {
    const msg = ledgerMessages[i];
    if (msg.message.messageId) {
      ledgerIdxByMessageId.set(msg.message.messageId, i);
    }
    const ts = parseIsoMs(msg.message.createdAt) ?? parseIsoMs(msg.storedAt);
    ledgerTimestamps[i] = ts;
    if (ts !== null && (oldestLedgerMs === null || ts < oldestLedgerMs)) {
      oldestLedgerMs = ts;
    }
  }

  const beforeSlot: DmExecutionTimelineItem[][] = Array.from({ length: n }, () => []);
  const afterSlot: DmExecutionTimelineItem[][] = Array.from({ length: n }, () => []);
  const tail: DmExecutionTimelineItem[] = [];
  const hasEarlierLedger = options?.hasEarlierLedger === true;

  for (const exec of executions) {
    if (!isExecutionItemVisible(exec)) continue;

    // 1. Causal anchor: execution produced ledger M_j -> immediately before M_j.
    if (exec.producedMessageId !== undefined) {
      const producedIdx = ledgerIdxByMessageId.get(exec.producedMessageId);
      if (producedIdx !== undefined) {
        beforeSlot[producedIdx].push(exec);
        continue;
      }
    }

    // 2. Live execution -> tail (sticks to bottom).
    if (exec.isLive || isTurnLive(exec.turn)) {
      tail.push(exec);
      continue;
    }

    // 3. Causal anchor: execution triggered by ledger M_k -> immediately after M_k.
    const triggerId = exec.triggerMessageId ?? exec.turn.attribution?.replyTo;
    const side = turnSideMetadata.get(exec.turn);
    let triggerIdx = triggerId !== undefined ? ledgerIdxByMessageId.get(triggerId) : undefined;
    if (triggerIdx === undefined && side?.responseMessageId) {
      triggerIdx = ledgerIdxByMessageId.get(side.responseMessageId);
    }
    if (triggerIdx !== undefined) {
      afterSlot[triggerIdx].push(exec);
      continue;
    }

    // 4. Unanchored fallback: honor pagination window cutoff, then timestamp-merge.
    const anchorTs = executionAnchorMs(exec);
    if (
      hasEarlierLedger &&
      oldestLedgerMs !== null &&
      anchorTs !== null &&
      anchorTs < oldestLedgerMs - LEDGER_PAGINATION_CUTOFF_GRACE_MS
    ) {
      continue;
    }

    if (n === 0 || anchorTs === null) {
      tail.push(exec);
      continue;
    }

    let placed = false;
    for (let i = 0; i < n; i += 1) {
      const msgTs = ledgerTimestamps[i];
      if (msgTs !== null && anchorTs <= msgTs) {
        beforeSlot[i].push(exec);
        placed = true;
        break;
      }
    }
    if (!placed) {
      tail.push(exec);
    }
  }

  const items: DmTimelineItem[] = [];
  for (let i = 0; i < n; i += 1) {
    const msg = ledgerMessages[i];
    const msgId = msg.message.messageId;
    const before = beforeSlot[i];
    if (before.length > 1) {
      before.sort((a, b) => {
        const aIsProducer = msgId !== '' && a.producedMessageId === msgId ? 1 : 0;
        const bIsProducer = msgId !== '' && b.producedMessageId === msgId ? 1 : 0;
        if (aIsProducer !== bIsProducer) return aIsProducer - bIsProducer;
        return compareExecutions(a, b);
      });
    }
    for (const exec of before) items.push(exec);

    items.push({
      kind: 'ledger',
      key: msgId ? `ledger:${msgId}` : `ledger:local:${msg.localId}`,
      message: msg,
      ledgerIndex: i,
    });

    const after = afterSlot[i];
    if (after.length > 1) after.sort(compareExecutions);
    for (const exec of after) items.push(exec);
  }

  if (tail.length > 1) {
    tail.sort((a, b) => {
      const aLive = a.isLive ? 1 : 0;
      const bLive = b.isLive ? 1 : 0;
      if (aLive !== bLive) return aLive - bLive;
      return compareExecutions(a, b);
    });
  }
  for (const exec of tail) items.push(exec);

  return items;
}

/**
 * End-to-end DM scope timeline builder combining both participants' primary streams
 * with canonical `scopeHistory` ledger messages and tool-output visibility settings.
 */
export function buildDmScopeTimeline({
  scopeId,
  ledgerMessages,
  members,
  knownBots,
  hideToolOutput,
  hasEarlierLedger,
}: BuildDmScopeTimelineInput): DmScopeTimelineResult {
  const allExecutions: DmExecutionTimelineItem[] = [];
  const liveStatuses: DmMemberLiveStatus[] = [];

  for (const source of members) {
    const liveRes = resolveMemberLiveForDmScope(source, scopeId);
    const scopedTurns = extractMemberDmExecutionTurns(source, scopeId, {
      knownBots,
      liveResolution: liveRes,
    });
    const stripped = stripRedundantDmSendTo(
      scopedTurns,
      source.member,
      scopeId,
      ledgerMessages,
    );

    const latestScopedTurn = scopedTurns.at(-1);
    const hasThinking = Boolean(
      !hideToolOutput &&
        liveRes.isBusy &&
        !liveRes.isStreaming &&
        (liveRes.hasThinking ||
          Boolean(
            latestScopedTurn &&
              isTurnLive(latestScopedTurn) &&
              latestScopedTurn.thinking &&
              latestScopedTurn.thinking.trim().length > 0,
          )),
    );
    const failureDetail =
      liveRes.failureDetail !== null &&
      !(liveRes.activity.source === null && Boolean(latestScopedTurn?.error))
        ? liveRes.failureDetail
        : null;

    liveStatuses.push({
      member: source.member,
      isBusy: liveRes.isBusy,
      activity: liveRes.activity,
      isStreaming: liveRes.isStreaming,
      activeToolName: hideToolOutput ? null : liveRes.activeToolName,
      hasThinking,
      startedAt: liveRes.startedAt,
      failureDetail,
    });

    if (hideToolOutput) {
      for (const exec of stripped) {
        const [filteredTurn] = chatTurnsWithoutToolOutput([exec.turn], {
          preserveBotDmSendTo: false,
        });
        if (!filteredTurn) continue;
        const side = turnSideMetadata.get(exec.turn);
        if (side) turnSideMetadata.set(filteredTurn, side);
        allExecutions.push({
          ...exec,
          turn: filteredTurn,
          silentPass: false,
        });
      }
    } else {
      allExecutions.push(...stripped);
    }
  }

  const items = mergeDmLedgerAndExecutions(ledgerMessages, allExecutions, {
    hasEarlierLedger,
  });

  return { items, liveStatuses };
}
