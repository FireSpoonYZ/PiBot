// 桌面端合并对话流（设计 5.3）：raw 历史分页 + live 实时窗口 → 统一 ChatTurn 渲染。
// 合并语义与手机端 Host.tsx 一致：同 entry id 以 raw 历史为准（工具/思考细节更全），
// live.history 只补齐尚未分页到的新窗口，不作为全量历史覆盖；历史问卷只读。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { BotLiveState, BotRecord, LiveTool } from '../../../host-core/index.js';
import { Markdown } from '../../../web/src/Markdown';
import {
  latestEntryChannel,
  parseHistoryEntries,
  formatTurnDuration,
  normalizeAttribution,
  type ChatTurn,
  type ChatToolCallItem,
} from '../../../web/src/chatTurnModel';
import { isWebhookAttribution, MessageAttribution as MessageAttributionBadge } from '../../../web/src/MessageAttribution';
import type { QuestionnaireSubmitPayload, VaultUnlockSubmitPayload } from '../../../web/src/ToolPresentation';
import { ToolCallCard } from '../../../web/src/ToolCallCard';
import {
  GrokBotAvatar,
  GrokBotWorkingSlot,
  resolveBotAvatarPreset,
} from '../../../web/src/GrokBotAvatar';
import {
  isBotActivityBusy,
  resolveActiveActivityStartedAt,
  type BotActivity,
} from '../../../web/src/botActivity';
import { ErrorNotice, useText } from '../../../web/src/ui';
import { SentAttachments, type AttachmentFetcher } from '../../../web/src/imageAttachments';
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
  /** 按 attachmentId 取图显示；null 表示当前不可读取附件（离线/无权限）。 */
  attachmentFetcher?: AttachmentFetcher | null;
  loading?: boolean;
  error?: string | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onRetry?: () => void;
  emptyActions?: ReactNode;
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
  attachmentFetcher = null,
  loading = false,
  error = null,
  hasMore = false,
  onLoadMore,
  onRetry,
  emptyActions,
}: ChatTranscriptProps) {
  const t = useText();
  const [linkError, setLinkError] = useState('');
  const botKey = avatarKey ?? `${bot.deviceId}:${bot.botId}`;
  const isBusy = live?.busy === true;
  const liveGeneratingText = typeof live?.generation?.text === 'string' ? live.generation.text : '';
  // 工作槽覆盖排队/准备/停止中/压缩阶段：Host 原生 isBusy 之外的统一口径由父级 activity 提供。
  const slotBusy = isBusy || (activity !== null && isBotActivityBusy(activity));

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
    () => normalizeAttribution((live?.generation as { attribution?: unknown } | null | undefined)?.attribution),
    [live?.generation],
  );
  const mergedItems = useMemo(() => {
    // 与手机端 Host.tsx 相同：live 投影窗口先放，raw 分页后放（同 id 覆盖，细节更全）。
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of asArray<Record<string, unknown>>(live?.history)) {
      byId.set(String(item.id), item);
    }
    for (const item of entries) byId.set(String(item.id), item as unknown as Record<string, unknown>);
    return [...byId.values()].sort((a, b) => numericId(a) - numericId(b));
  }, [entries, live?.history]);

  // dm/room 触发的生成是协作过程，不进普通聊天：generation.attribution 缺失但 tools
  // 仍活跃时退回合并历史中最新执行来源（与 parser 内部同一判断）。
  const liveIsCollaborative =
    isBusy && (liveAttribution?.channel ?? latestEntryChannel(mergedItems, bot.botId)) !== 'primary';
  const displayGeneratingText = liveIsCollaborative ? '' : liveGeneratingText;

  const allTurns = useMemo<ChatTurn[]>(() =>
    parseHistoryEntries(mergedItems, 0, {
      liveTools: asArray<Record<string, unknown>>(live?.tools),
      isBusy,
      liveGeneratingText: displayGeneratingText,
      liveGeneratingBlocks: liveIsCollaborative ? undefined : live?.generation?.blocks,
      selfBotId: bot.botId,
      liveAttribution,
      trackAssistantTextEntries: true,
    }),
  [mergedItems, live, isBusy, displayGeneratingText, liveAttribution, bot.botId]);

  const activeLiveToolName = useMemo(() => {
    if (liveIsCollaborative) return null;
    const tools = asArray<LiveTool>(live?.tools);
    for (let i = tools.length - 1; i >= 0; i -= 1) {
      const name = typeof tools[i]?.name === 'string' ? tools[i].name.trim() : '';
      if (name && tools[i]?.status !== 'done') return name;
    }
    const last = tools[tools.length - 1];
    return typeof last?.name === 'string' && isBusy && !liveGeneratingText ? last.name.trim() : null;
  }, [live?.tools, isBusy, liveGeneratingText, liveIsCollaborative]);

  const visibleTurns = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allTurns;
    return allTurns.filter(
      (turn) =>
        turn.text.toLowerCase().includes(q) ||
        Boolean(turn.tools?.some((tool) => tool.name.toLowerCase().includes(q))),
    );
  }, [allTurns, search]);

  const lastTurn = visibleTurns.at(-1);

  // 当前执行轮真实开始：共享 helper 取 Host activity.startedAt（冻结轮 frozenAt，
  // 仅忙碌相位返回），旧 Host 返回 null 由 WorkingSlot 的 observed-busy 缓存落锚，
  // 绝不回退历史用户/普通轮时间。
  const workingSlotStartedAt = resolveActiveActivityStartedAt(activity);

  // 持久失败可见化：Host 的 failed 终态持续显示（区别于用户主动停止），
  // 优先 activity.error（执行失败有界诊断），回落 live.turnAdmission.error（受理失败）。
  const phaseFailed = activity?.phase === 'failed';
  const activityError = activity?.error?.message || activity?.error?.code || null;
  const admissionError = useMemo(() => {
    const adm = live?.turnAdmission;
    if (!adm || adm.phase !== 'failed') return null;
    const msg = adm.error?.message || adm.error?.code || '';
    return msg ? String(msg) : null;
  }, [live?.turnAdmission]);
  const failureNotice = phaseFailed
    ? (activityError ?? admissionError)
      ? t('本次执行失败：', 'This run failed: ') + (activityError ?? admissionError)
      : t('本次执行失败，请重试或检查配置。', 'This run failed. Retry or check the configuration.')
    : null;

  // 工具芯片/卡片的单工具渲染：有序块与回退 tools 列表共用同一 JSX，
  // 保证 live→历史 与块内/块外渲染一致。
  const renderToolChip = (tool: ChatToolCallItem) => (
    <ToolCallCard
      key={tool.id}
      tool={tool}
      scopeKey={scopeKey ?? `${botKey}:${bot.primaryConversationId}`}
      active={isBusy && !archived}
      disabled={disabled || archived}
      variant="desktop"
      requesterName={bot.role}
      onSubmitQuestionnaire={onSubmitQuestionnaire}
      onSubmitVaultUnlock={onSubmitVaultUnlock}
    />
  );

  // 仅当用户停留在底部附近时跟随新流；向上翻阅历史不打断滚动位置。
  const scrollRef = useRef<HTMLElement | null>(null);
  const nearBottomRef = useRef(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [visibleTurns.length, lastTurn?.text, lastTurn?.tools?.length, liveGeneratingText, isBusy, activeLiveToolName]);

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

  return (
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
      ) : (
        visibleTurns.map((turn, turnIdx) => {
          const isLastAssistantTurn = turn.role === 'assistant' && turnIdx === visibleTurns.length - 1;
          const showTurnDuration =
            turn.role === 'assistant' &&
            typeof turn.durationMs === 'number' &&
            turn.durationMs > 0 &&
            !(isLastAssistantTurn && isBusy);
          const turnAttr = turn.attribution;
          return (
            <article
              key={turn.id}
              className={`bot-chat-bubble ${isWebhookAttribution(turnAttr) ? 'assistant' : turn.role}${turn.isStreaming ? ' streaming' : ''}`}
            >
              {turnAttr ? (
                <MessageAttributionBadge attribution={turnAttr} />
              ) : null}
              {turn.role === 'assistant' && turn.blocks
                ? turn.blocks.map((block) =>
                    block.kind === 'thinking' ? (
                      <details key={block.id} className="bot-chat-thinking">
                        <summary>{t('思考过程', 'Thinking')}</summary>
                        <pre>{block.text}</pre>
                      </details>
                    ) : block.kind === 'tools' ? (
                      <div key={block.id} className="bot-chat-tools" role="list" aria-label={t('工具调用', 'Tool calls')}>
                        {block.tools.map((tool) => renderToolChip(tool))}
                      </div>
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
                <div className="bot-chat-tools" role="list" aria-label={t('工具调用', 'Tool calls')}>
                  {turn.tools.map((tool) => renderToolChip(tool))}
                </div>
              ) : null}
              {turn.role === 'user' && turn.attachments && turn.attachments.length > 0 ? (
                <SentAttachments attachments={turn.attachments} fetcher={attachmentFetcher} />
              ) : null}
              {!turn.blocks && turn.text ? <Markdown text={turn.text} onOpenLink={openLink} /> : null}
              <ErrorNotice
                compact
                error={
                  turn.error === 'model_error'
                    ? t('模型生成失败，请重试或检查模型配置。', 'Model generation failed. Retry or check the model configuration.')
                    : turn.error
                }
              />
              {showTurnDuration ? (
                <div className="bot-chat-turn-meta" aria-label={formatTurnDuration(turn.durationMs!, t)}>
                  <svg className="bot-chat-turn-clock" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M8 5v3.25l2.1 1.35" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>{formatTurnDuration(turn.durationMs!, t)}</span>
                </div>
              ) : null}
            </article>
          );
        })
      )}

      {!awaitingAnswer ? <GrokBotWorkingSlot
        key={botKey}
        botKey={botKey}
        preset={avatarPreset}
        isBusy={slotBusy}
        activity={activity ?? undefined}
        isStreaming={Boolean(displayGeneratingText)}
        activeToolName={activeLiveToolName}
        hasThinking={Boolean(lastTurn?.role === 'assistant' && lastTurn.thinking && !displayGeneratingText)}
        queuedCount={live?.queuedCount ?? 0}
        hasError={Boolean(lastTurn?.error) || phaseFailed}
        startedAt={workingSlotStartedAt}
        t={t}
      /> : null}
      {failureNotice ? (
        <ErrorNotice compact error={failureNotice} />
      ) : null}
      <ErrorNotice error={linkError} onDismiss={() => setLinkError('')} compact />
    </section>
  );
}
