// 桌面端合并对话流（设计 5.3）：raw 历史分页 + live 实时窗口 → 统一 ChatTurn 渲染。
// 合并语义与手机端 Host.tsx 一致：同 entry id 以 raw 历史为准（工具/思考细节更全），
// live.history 只补齐尚未分页到的新窗口，不作为全量历史覆盖；历史问卷只读。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import type { BotLiveState, BotRecord, LiveTool } from '../../../host-core/index.js';
import { Markdown } from '../../../web/src/Markdown';
import { ChatTurnMeta } from '../../../web/src/ChatTurnMeta';
import {
  chatTurnsWithoutBotDm,
  chatTurnsWithoutToolOutput,
  hasAssistantVisibleContent,
  isBotDmSendToTool,
  isBotDmTurn,
  latestEntryChannel,
  mergeHistoryWaitProjection,
  parseHistoryEntries,
  normalizeAttribution,
  resolveAssistantFailureDetail,
  type ChatTurn,
  type KnownBotSummary,
} from '../../../web/src/chatTurnModel';
import { BotDmFoldCard, resolveBotDmTurnSummary } from '../../../web/src/BotDmCard';
import { isWebhookAttribution, MessageAttribution as MessageAttributionBadge } from '../../../web/src/MessageAttribution';
import type {
  GoogleChatCardContext,
  QuestionnaireSubmitPayload,
  VaultUnlockSubmitPayload,
} from '../../../web/src/ToolPresentation';
import { selectCurrentGoogleSetup } from '../../../web/src/google/currentGoogleSetup';
import { CurrentGoogleSetupCard } from '../../../web/src/google/CurrentGoogleSetupCard';
import { TurnToolCallsSection } from '../../../web/src/hub/shared';
import {
  GrokBotAvatar,
  GrokBotFailureRow,
  GrokBotWorkingSlot,
  resolveBotAvatarPreset,
} from '../../../web/src/GrokBotAvatar';
import {
  isBotActivityBusy,
  resolveActiveActivityStartedAt,
  type BotActivity,
} from '../../../web/src/botActivity';
import {
  ErrorNotice,
  useCollapseBotDm,
  useCollapseToolOutput,
  useHideBotDm,
  useHideToolOutput,
  useText,
} from '../../../web/src/ui';
import { SentAttachments, type AttachmentFetcher } from '../../../web/src/imageAttachments';
import { isEditablePrimaryUserTurn } from '../../../web/src/composerFlowControl';
import './ChatTranscript.css';

export interface ChatTranscriptEntry {
  id: unknown;
  kind: string;
  model?: unknown;
  data?: unknown;
}

export interface ChatTranscriptProps {
  entries: ChatTranscriptEntry[];
  live: BotLiveState | null;
  /** 已知最新重置边界（pi.reset id）；用于立即屏蔽 <= 此值的旧合并条目与旧失败投影。 */
  clearedThroughEntryId?: number;
  bot: BotRecord;
  /** 统一工作状态（含本地乐观发送/停止投影），由 BotChats 唯一口径计算后传入；
   *  缺省（预览等无父级场景）按 idle 处理，不在此处二次推导。 */
  activity?: BotActivity | null;
  awaitingAnswer?: boolean;
  /** 与 BotChats 持久化头像键一致（local:local:botId / remote:profileId:deviceId:botId）；
   *  缺省回退 deviceId:botId，仅供无持久化上下文的预览使用。 */
  avatarKey?: string;
  /** 目录侧设备平台徽标；BotRecord 无此字段，由 BotChats 从 devices 目录传入。 */
  devicePlatform?: string;
  /** 会话内搜索关键字；空串显示全部轮次。 */
  search: string;
  boardResultId?: string;
  onViewedResult?: (id: string) => void;
  questionnaireRequestId?: string;
  onQuestionnaireFocused?: (id: string) => void;
  archived: boolean;
  /** 工具交互身份含连接代与会话；不复用其他上下文的密码输入。 */
  scopeKey?: string;
  disabled?: boolean;
  onSubmitQuestionnaire: (installationId: string, input: QuestionnaireSubmitPayload) => Promise<unknown>;
  onSubmitVaultUnlock?: (input: VaultUnlockSubmitPayload) => Promise<unknown>;
  googleContext?: GoogleChatCardContext;
  /** 输入区正上方的稳定插槽容器；通过 Portal 挂载唯一的 CurrentGoogleSetupCard。 */
  googleSetupSlotContainer?: HTMLElement | null;
  onGoogleSetupBrowserTakeoverActiveChange?: (active: boolean) => void;
  /** 按 attachmentId 取图显示；null 表示当前不可读取附件（离线/无权限）。 */
  attachmentFetcher?: AttachmentFetcher | null;
  loading?: boolean;
  error?: string | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onRetry?: () => void;
  onOpenLearnedSkills?: () => void;
  emptyActions?: ReactNode;
  knownBots?: readonly KnownBotSummary[];
  /** 仅空闲且在线未归档时允许编辑历史消息；忙碌时严格禁止。 */
  canEditTurns?: boolean;
  editingEntryId?: number | null;
  onEditTurn?: (turn: ChatTurn) => void;
  onOpenTask?: (taskId: string, openEdit?: boolean) => void;
  onConfirmTaskPlan?: (taskId: string) => Promise<void> | void;
  onAnswerTaskPrompt?: (taskId: string, answer: string) => Promise<void> | void;
}

const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** 距离底部不足此值视为“用户正跟随最新流”；向上翻阅后新流不打断阅读。 */
const NEAR_BOTTOM_PX = 72;

function numericId(item: Record<string, unknown>): number {
  const id = Number(item.id);
  return Number.isFinite(id) ? id : 0;
}

export function ChatTranscript({
  entries,
  live,
  clearedThroughEntryId = 0,
  bot,
  activity = null,
  awaitingAnswer = false,
  avatarKey,
  devicePlatform,
  search,
  boardResultId,
  onViewedResult,
  questionnaireRequestId,
  onQuestionnaireFocused,
  archived,
  scopeKey,
  disabled = false,
  onSubmitQuestionnaire,
  onSubmitVaultUnlock,
  googleContext,
  googleSetupSlotContainer = null,
  onGoogleSetupBrowserTakeoverActiveChange,
  attachmentFetcher = null,
  loading = false,
  error = null,
  hasMore = false,
  onLoadMore,
  onRetry,
  onOpenLearnedSkills,
  emptyActions,
  knownBots,
  canEditTurns = false,
  editingEntryId = null,
  onEditTurn,
  onOpenTask,
  onConfirmTaskPlan,
  onAnswerTaskPrompt,
}: ChatTranscriptProps) {
  const t = useText();
  const [hideToolOutput] = useHideToolOutput();
  const [collapseToolOutput] = useCollapseToolOutput();
  const [hideBotDm] = useHideBotDm();
  const [collapseBotDm] = useCollapseBotDm();
  const [linkError, setLinkError] = useState('');
  const botKey = avatarKey ?? `${bot.deviceId}:${bot.botId}`;
  const effectiveClearedThrough = useMemo(() => {
    let cutoff =
      typeof clearedThroughEntryId === 'number' &&
      Number.isSafeInteger(clearedThroughEntryId) &&
      clearedThroughEntryId > 0
        ? clearedThroughEntryId
        : 0;
    for (const item of asArray<Record<string, unknown>>(live?.history)) {
      if (item?.kind === 'pi.reset') {
        const id = numericId(item);
        if (id > cutoff) cutoff = id;
      }
    }
    for (const item of entries) {
      if (item?.kind === 'pi.reset') {
        const id = numericId(item as unknown as Record<string, unknown>);
        if (id > cutoff) cutoff = id;
      }
    }
    return cutoff;
  }, [clearedThroughEntryId, live?.history, entries]);
  const effectiveLive = useMemo(() => {
    if (!live || effectiveClearedThrough <= 0) return live;
    const history = asArray<Record<string, unknown>>(live.history);
    const hasMarker = history.some((item) => item?.kind === 'pi.reset' && numericId(item) >= effectiveClearedThrough);
    if (hasMarker) return live;
    const lastId = typeof live.lastEntryId === 'number' && Number.isFinite(live.lastEntryId) ? live.lastEntryId : null;
    if (lastId !== null && lastId > effectiveClearedThrough) return live;
    return history.some((item) => numericId(item) > effectiveClearedThrough) ? live : null;
  }, [live, effectiveClearedThrough]);
  const isBusy = effectiveLive?.busy === true;
  const liveGeneratingText = typeof effectiveLive?.generation?.text === 'string' ? effectiveLive.generation.text : '';
  // 工作槽覆盖排队/准备/停止中/压缩阶段：Host 原生 isBusy 之外的统一口径由父级 activity 提供。
  const slotBusy = isBusy || (effectiveLive !== null && activity !== null && isBotActivityBusy(activity));

  // 桌面端无 mobile 桥：Markdown 链接统一走 desktop_open_center 原生命令（仅放行 HTTPS），失败可见化。
  const openLink = useCallback((href: string) => {
    setLinkError('');
    return invoke('desktop_open_center', { url: href }).catch((e: unknown) => {
      setLinkError(e instanceof Error ? e.message : String(e));
    });
  }, []);

  // LiveGeneration.attribution（同 id 的 raw data.attribution 已由 raw 覆盖）；
  // 仍在生成的活轮用它标记协作来源/方向，不混同普通用户答案。
  const liveAttribution = useMemo(
    () => normalizeAttribution((effectiveLive?.generation as { attribution?: unknown } | null | undefined)?.attribution),
    [effectiveLive?.generation],
  );
  const activeDurableWaits = disabled || archived ? undefined : effectiveLive?.durableWaits;
  const mergedItems = useMemo(() => {
    // 与手机端 Host.tsx 相同：live 投影窗口先放，raw 分页后放（同 id 覆盖，细节更全），
    // 同时合入 Host 投影的 durable wait 状态（缺省 = 不支持/离线 -> 只读；[] = 已知无活跃）。
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of asArray<Record<string, unknown>>(effectiveLive?.history)) {
      const id = numericId(item);
      if (effectiveClearedThrough > 0 && id > 0 && id <= effectiveClearedThrough) continue;
      byId.set(String(item.id), mergeHistoryWaitProjection(item, undefined, activeDurableWaits));
    }
    for (const item of entries) {
      const rec = item as unknown as Record<string, unknown>;
      const id = numericId(rec);
      if (effectiveClearedThrough > 0 && id > 0 && id <= effectiveClearedThrough) continue;
      byId.set(String(item.id), mergeHistoryWaitProjection(rec, byId.get(String(item.id)), activeDurableWaits));
    }
    return [...byId.values()].sort((a, b) => numericId(a) - numericId(b));
  }, [entries, effectiveLive?.history, effectiveClearedThrough, activeDurableWaits]);

  // 群聊（room）以及用户选择隐藏时的 Bot 间私聊（dm）不向主对话页吐出流式正文与工具名。
  const liveChannel = liveAttribution?.channel ?? latestEntryChannel(mergedItems, bot.botId);
  const liveIsCollaborative = isBusy && (liveChannel === 'room' || (hideBotDm && liveChannel === 'dm'));
  const displayGeneratingText = liveIsCollaborative ? '' : liveGeneratingText;

  const allTurns = useMemo<ChatTurn[]>(() =>
    parseHistoryEntries(mergedItems, effectiveClearedThrough, {
      liveTools: asArray<Record<string, unknown>>(effectiveLive?.tools),
      isBusy,
      liveGeneratingText: displayGeneratingText,
      liveGeneratingBlocks: liveIsCollaborative ? undefined : effectiveLive?.generation?.blocks,
      selfBotId: bot.botId,
      liveAttribution,
      trackAssistantTextEntries: true,
      knownBots,
      durableWaits: activeDurableWaits,
    }),
  [mergedItems, effectiveClearedThrough, effectiveLive, isBusy, displayGeneratingText, liveAttribution, bot.botId, liveIsCollaborative, knownBots, activeDurableWaits]);

  const currentGoogleSetup = useMemo(
    () => selectCurrentGoogleSetup(allTurns),
    [allTurns],
  );

  const activeLiveToolName = useMemo(() => {
    if (liveIsCollaborative || hideToolOutput) return null;
    const tools = asArray<LiveTool>(effectiveLive?.tools);
    for (let i = tools.length - 1; i >= 0; i -= 1) {
      const name = typeof tools[i]?.name === 'string' ? tools[i].name.trim() : '';
      if (name && tools[i]?.status !== 'done') return name;
    }
    const last = tools[tools.length - 1];
    return typeof last?.name === 'string' && isBusy && !liveGeneratingText ? last.name.trim() : null;
  }, [effectiveLive?.tools, isBusy, liveGeneratingText, liveIsCollaborative, hideToolOutput]);

  const turnsAfterDmFilter = useMemo(
    () => (hideBotDm ? chatTurnsWithoutBotDm(allTurns) : allTurns),
    [allTurns, hideBotDm],
  );

  const visibleTurns = useMemo(() => {
    const turns = hideToolOutput
      ? chatTurnsWithoutToolOutput(turnsAfterDmFilter, { preserveBotDmSendTo: !hideBotDm })
      : turnsAfterDmFilter;
    const q = search.trim().toLowerCase();
    if (!q) return turns;
    return turns.filter(
      (turn) =>
        turn.text.toLowerCase().includes(q) ||
        Boolean(turn.attribution?.name && turn.attribution.name.toLowerCase().includes(q)) ||
        Boolean(
          turn.tools?.some(
            (tool) =>
              (isBotDmSendToTool(tool, turn) &&
                ((tool.sendTo?.text && tool.sendTo.text.toLowerCase().includes(q)) ||
                  (tool.sendTo?.targetName && tool.sendTo.targetName.toLowerCase().includes(q)))) ||
              (!hideToolOutput &&
                (tool.name.toLowerCase().includes(q) ||
                  (tool.argSummary && tool.argSummary.toLowerCase().includes(q)) ||
                  (tool.output && tool.output.toLowerCase().includes(q)))),
          ),
        ),
    );
  }, [turnsAfterDmFilter, search, hideBotDm, hideToolOutput]);

  const lastTurn = visibleTurns.at(-1);

  // 当前执行轮真实开始：共享 helper 取 Host activity.startedAt（冻结轮 frozenAt，
  // 仅忙碌相位返回），旧 Host 返回 null 由 WorkingSlot 的 observed-busy 缓存落锚，
  // 绝不回退历史用户/普通轮时间。
  const workingSlotStartedAt = resolveActiveActivityStartedAt(activity);

  // 持久失败可见化：已入历史的 assistant 失败轮统一用轮内 GrokBotFailureRow 原位展示；
  // 尚未落入历史的 failed 终态（如请求前 Host 中止）由 GrokBotWorkingSlot 融合展示，避免重复与闪跳。
  const latestTurn = turnsAfterDmFilter.at(-1);
  const latestTurnHasError = Boolean(latestTurn?.role === 'assistant' && latestTurn.error);
  const liveStale = effectiveClearedThrough > 0 && live !== null && effectiveLive === null;
  const phaseFailed = !liveStale && activity?.phase === 'failed';
  const admissionError = useMemo(() => {
    const adm = effectiveLive?.turnAdmission;
    if (!adm || adm.phase !== 'failed') return null;
    const msg = adm.error?.message || adm.error?.code || '';
    return msg ? String(msg) : 'admission_failed';
  }, [effectiveLive?.turnAdmission]);
  const showFusedFailure = phaseFailed && !slotBusy && !awaitingAnswer && !admissionError && !latestTurnHasError;
  const rawActivityError =
    activity?.error?.message?.trim() || activity?.error?.code?.trim() || '';
  const fusedFailureDetail = showFusedFailure ? rawActivityError : '';
  const slotFailure = useMemo(
    () => (showFusedFailure ? { detail: fusedFailureDetail || undefined } : undefined),
    [showFusedFailure, fusedFailureDetail],
  );

  // 仅当用户停留在底部附近时跟随新流；向上翻阅历史不打断滚动位置。
  const scrollRef = useRef<HTMLElement | null>(null);
  const nearBottomRef = useRef(true);
  const lastClientHeightRef = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (
      nearBottomRef.current &&
      lastClientHeightRef.current !== null &&
      el.clientHeight < lastClientHeightRef.current
    ) {
      lastClientHeightRef.current = el.clientHeight;
      el.scrollTop = el.scrollHeight;
      return;
    }
    lastClientHeightRef.current = el.clientHeight;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    lastClientHeightRef.current = el.clientHeight;
    const observer = new ResizeObserver(() => {
      lastClientHeightRef.current = el.clientHeight;
      if (nearBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [botKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [visibleTurns.length, lastTurn?.text, lastTurn?.tools?.length, lastTurn?.error, liveGeneratingText, activeLiveToolName, showFusedFailure]);

  // 切换会话回到最新流。
  useEffect(() => {
    nearBottomRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [botKey]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !boardResultId || !onViewedResult || loading || error || disabled ||
        typeof IntersectionObserver !== 'function') return;
    const blocks = root.querySelectorAll(`[data-assistant-entry-id="${CSS.escape(boardResultId)}"]`);
    if (!blocks.length) return;
    let watching = true;
    // Report the first positive intersection even when the block initially touches the viewport edge.
    const observer = new IntersectionObserver((entries) => {
      if (!watching || document.hidden || !root.isConnected || root.dataset.boardResultId !== boardResultId) return;
      if (entries.some(({ target, intersectionRect }) =>
        intersectionRect.width > 0 && intersectionRect.height > 0 && root.contains(target),
      )) {
        observer.disconnect();
        watching = false;
        onViewedResult(boardResultId);
      }
    }, { root, threshold: [0, Number.EPSILON] });
    blocks.forEach(block => observer.observe(block));
    return () => {
      watching = false;
      observer.disconnect();
    };
  }, [boardResultId, onViewedResult, visibleTurns, loading, error, disabled]);

  useEffect(() => {
    if (!questionnaireRequestId || !onQuestionnaireFocused || disabled || loading || document.hidden) return;
    const questionnaire = scrollRef.current?.querySelector(
      `[data-active-questionnaire="${CSS.escape(questionnaireRequestId)}"]`,
    );
    if (!questionnaire) return;
    const question = questionnaire.querySelector('fieldset[data-unanswered]');
    const control = question?.querySelector<HTMLElement>('.tp-options input:enabled, summary') ??
      questionnaire.querySelector<HTMLButtonElement>('button.tp-btn-primary:enabled');
    if (!control) return;
    (question ?? control).scrollIntoView({ block: 'start', inline: 'nearest' });
    control.focus({ preventScroll: true });
    onScroll();
    onQuestionnaireFocused(questionnaireRequestId);
  }, [questionnaireRequestId, onQuestionnaireFocused, visibleTurns, disabled, loading, onScroll]);

  const avatarPreset = resolveBotAvatarPreset(botKey, bot.role, bot.isPrimary);
  const platformBadge = devicePlatform || 'host';
  const currentGoogleSetupPortal = googleSetupSlotContainer
    ? createPortal(
        <CurrentGoogleSetupCard
          hostRevision={effectiveLive?.googleSetupRevision}
          scopeKey={scopeKey ?? `${botKey}:${bot.primaryConversationId}`}
          presentation={currentGoogleSetup}
          googleContext={googleContext}
          disabled={disabled || archived}
          active={!archived}
          embeddedInDock
          onBrowserTakeoverActiveChange={onGoogleSetupBrowserTakeoverActiveChange}
        />,
        googleSetupSlotContainer,
      )
    : null;

  return (
    <>
      <section
      className="desktop-transcript bot-chat-messages"
      ref={scrollRef}
      onScroll={onScroll}
      data-board-result-id={!loading && !error && !disabled ? boardResultId : undefined}
      aria-label={t('对话消息', 'Conversation')}
    >
      {hasMore || loading || error ? (
        <div className="desktop-transcript-pager">
          {hasMore ? (
            <button
              type="button"
              className="secondary-button"
              disabled={loading}
              onClick={onLoadMore}
            >
              {loading ? t('加载中…', 'Loading…') : t('加载更多消息', 'Load more messages')}
            </button>
          ) : null}
          {loading && !hasMore ? (
            <span className="desktop-transcript-pager-status">{t('加载中…', 'Loading…')}</span>
          ) : null}
          <ErrorNotice
            compact
            error={error ?? undefined}
            actionLabel={error && onRetry ? t('重试', 'Retry') : undefined}
            onAction={onRetry}
          />
        </div>
      ) : null}

      {visibleTurns.length === 0 && !displayGeneratingText ? (
        <div className="desktop-transcript-empty bot-chat-empty">
          <GrokBotAvatar preset={avatarPreset} isPrimary={bot.isPrimary} starBadge={bot.isPrimary} platformBadge={platformBadge} offline={disabled} size={84} />
          <h2>{bot.role}</h2>
          <p>{bot.description || t('开始一段新的对话。', 'Start a new conversation.')}</p>
          {search.trim() ? (
            <p className="desktop-transcript-empty-search">{t('没有匹配搜索的轮次。', 'No turns match the search.')}</p>
          ) : null}
          {emptyActions && !search.trim() && !loading && !error ? <div className="desktop-transcript-empty-actions">{emptyActions}</div> : null}
        </div>
      ) : (() => {
        const editingTargetIdx =
          typeof editingEntryId === 'number'
            ? visibleTurns.findIndex((item) => item.role === 'user' && item.entryId === editingEntryId)
            : -1;
        const searchQuery = search.trim().toLowerCase();
        return visibleTurns.map((turn, turnIdx) => {
          const isLastAssistantTurn = turn.role === 'assistant' && turnIdx === visibleTurns.length - 1;
          const showTurnDuration =
            turn.role === 'assistant' &&
            typeof turn.durationMs === 'number' &&
            turn.durationMs > 0 &&
            !(isLastAssistantTurn && isBusy);
          const turnAttr = turn.attribution;
          const isDmTurn = isBotDmTurn(turn);
          const isEditingTarget = editingTargetIdx === turnIdx;
          const isAfterEditingTarget = editingTargetIdx !== -1 && turnIdx > editingTargetIdx;
          const canEditThisTurn = Boolean(
            canEditTurns &&
              !slotBusy &&
              !archived &&
              !disabled &&
              onEditTurn &&
              isEditablePrimaryUserTurn(turn),
          );
          const copyText = turn.text;
          const isAssistantFailure = turn.role === 'assistant' && Boolean(turn.error);
          const showArticle = !isAssistantFailure || hasAssistantVisibleContent(turn);
          const failureDetail = isAssistantFailure ? resolveAssistantFailureDetail(
            turn.error === 'model_error' && turn.id === latestTurn?.id && phaseFailed && rawActivityError
              ? rawActivityError : turn.error,
            t,
          ) : '';
          const renderAssistantBody = (insideDm: boolean) => (
            <>
              {turn.blocks
                ? turn.blocks.map((block) =>
                    block.kind === 'thinking' ? (
                      <details key={block.id} className="bot-chat-thinking">
                        <summary>{t('思考过程', 'Thinking')}</summary>
                        <pre>{block.text}</pre>
                      </details>
                    ) : block.kind === 'tools' ? (
                      <TurnToolCallsSection
                        key={block.id}
                        tools={block.tools}
                        collapseOutput={collapseToolOutput}
                        collapseBotDm={insideDm ? false : collapseBotDm}
                        insideBotDmTurn={insideDm}
                        forceExpandBotDm={Boolean(searchQuery)}
                        presentationOnly={hideToolOutput}
                        scopeKey={scopeKey ?? `${botKey}:${bot.primaryConversationId}`}
                        active={isBusy && !archived}
                        disabled={disabled || archived}
                        variant="desktop"
                        requesterName={bot.role}
                        googleContext={googleContext}
                        onSubmitQuestionnaire={onSubmitQuestionnaire}
                        onSubmitVaultUnlock={onSubmitVaultUnlock}
                        onOpenTask={onOpenTask}
                        onConfirmTaskPlan={onConfirmTaskPlan}
                        onAnswerTaskPrompt={onAnswerTaskPrompt}
                        t={t}
                      />
                    ) : (
                      <div key={block.id} data-assistant-entry-id={block.entryId}>
                        <Markdown text={block.text} onOpenLink={openLink} />
                      </div>
                    ),
                  )
                : null}
              {!turn.blocks && turn.thinking ? (
                <details className="bot-chat-thinking">
                  <summary>{t('思考过程', 'Thinking')}</summary>
                  <pre>{turn.thinking}</pre>
                </details>
              ) : null}
              {!turn.blocks && turn.tools && turn.tools.length > 0 ? (
                <TurnToolCallsSection
                  tools={turn.tools}
                  collapseOutput={collapseToolOutput}
                  collapseBotDm={insideDm ? false : collapseBotDm}
                  insideBotDmTurn={insideDm}
                  forceExpandBotDm={Boolean(searchQuery)}
                  presentationOnly={hideToolOutput}
                  scopeKey={scopeKey ?? `${botKey}:${bot.primaryConversationId}`}
                  active={isBusy && !archived}
                  disabled={disabled || archived}
                  variant="desktop"
                  requesterName={bot.role}
                  googleContext={googleContext}
                  onSubmitQuestionnaire={onSubmitQuestionnaire}
                  onSubmitVaultUnlock={onSubmitVaultUnlock}
                  onOpenTask={onOpenTask}
                  onConfirmTaskPlan={onConfirmTaskPlan}
                  onAnswerTaskPrompt={onAnswerTaskPrompt}
                  t={t}
                />
              ) : null}
              {!turn.blocks && turn.text ? <Markdown text={turn.text} onOpenLink={openLink} /> : null}
            </>
          );

          if (isDmTurn) {
            const dmSummary = resolveBotDmTurnSummary(turn, visibleTurns, turnIdx, t);
            return (
              <div key={turn.id} className={`bot-chat-turn is-bot-dm${turn.isStreaming ? ' is-streaming' : ''}`}>
                <BotDmFoldCard
                  direction={dmSummary.direction}
                  peerLabel={dmSummary.peerLabel}
                  tag={dmSummary.tag}
                  preview={dmSummary.preview}
                  meta={dmSummary.meta}
                  status={dmSummary.status}
                  silent={dmSummary.silent}
                  defaultCollapsed={collapseBotDm}
                  forceExpand={Boolean(searchQuery)}
                >
                  {turn.role === 'assistant' ? (
                    <>
                      {showArticle ? renderAssistantBody(true) : null}
                      {isAssistantFailure ? (
                        <GrokBotFailureRow
                          botKey={botKey}
                          preset={avatarPreset}
                          detail={failureDetail || undefined}
                          inline
                          t={t}
                        />
                      ) : null}
                    </>
                  ) : (
                    <>
                      {turn.attachments && turn.attachments.length > 0 ? (
                        <SentAttachments attachments={turn.attachments} fetcher={attachmentFetcher} />
                      ) : null}
                      {turn.text ? <Markdown text={turn.text} onOpenLink={openLink} /> : null}
                    </>
                  )}
                  <ChatTurnMeta
                    role={turn.role}
                    timestamp={turn.timestamp}
                    durationMs={showTurnDuration ? turn.durationMs : undefined}
                    copyText={dmSummary.copyText}
                  />
                </BotDmFoldCard>
              </div>
            );
          }

          return (
            <div key={turn.id} className={`bot-chat-turn${turn.isStreaming ? ' is-streaming' : ''}`}>
              {showArticle ? (
                <article
                  className={`bot-chat-bubble ${isWebhookAttribution(turnAttr) ? 'assistant' : turn.role}${turn.role === 'user' && turnAttr?.kind === 'bot' ? ' is-peer' : ''}${turn.isStreaming ? ' streaming' : ''}${isEditingTarget ? ' is-editing-target' : ''}${isAfterEditingTarget ? ' is-editing-after' : ''}`}
                >
                  {turnAttr ? (
                    <MessageAttributionBadge attribution={turnAttr} />
                  ) : null}
                  {turn.role === 'assistant' ? renderAssistantBody(false) : null}
                  {turn.role === 'user' && turn.attachments && turn.attachments.length > 0 ? (
                    <SentAttachments attachments={turn.attachments} fetcher={attachmentFetcher} />
                  ) : null}
                  {turn.role === 'user' && turn.text ? <Markdown text={turn.text} onOpenLink={openLink} /> : null}
                </article>
              ) : null}
              {isAssistantFailure ? (
                <GrokBotFailureRow
                  botKey={botKey}
                  preset={avatarPreset}
                  detail={failureDetail || undefined}
                  inline
                  t={t}
                />
              ) : null}
              <ChatTurnMeta
                role={turn.role}
                timestamp={turn.timestamp}
                durationMs={showTurnDuration ? turn.durationMs : undefined}
                copyText={copyText}
                onEdit={canEditThisTurn ? () => onEditTurn?.(turn) : undefined}
              />
            </div>
          );
        });
      })()}

      {!awaitingAnswer ? <GrokBotWorkingSlot
        key={botKey}
        botKey={botKey}
        preset={avatarPreset}
        isBusy={slotBusy}
        activity={liveStale ? undefined : (activity ?? undefined)}
        learning={effectiveLive?.learning ?? null}
        onOpenLearnedSkills={onOpenLearnedSkills}
        isStreaming={Boolean(displayGeneratingText)}
        activeToolName={activeLiveToolName}
        hasThinking={Boolean(lastTurn?.role === 'assistant' && lastTurn.thinking && !displayGeneratingText)}
        queuedCount={effectiveLive?.queuedCount ?? 0}
        hasError={latestTurnHasError || phaseFailed}
        startedAt={workingSlotStartedAt}
        failure={slotFailure}
        t={t}
      /> : null}
      <ErrorNotice error={linkError} onDismiss={() => setLinkError('')} compact />
      </section>
      {currentGoogleSetupPortal}
    </>
  );
}
