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
  resolveActiveTurnStartedAt,
  formatTurnDuration,
  normalizeAttribution,
  type ChatTurn,
} from '../../../web/src/chatTurnModel';
import { MessageAttribution as MessageAttributionBadge } from '../../../web/src/MessageAttribution';
import {
  readToolPresentation,
  ToolPresentationCard,
  type QuestionnaireSubmitPayload,
} from '../../../web/src/ToolPresentation';
import {
  GrokBotAvatar,
  GrokBotWorkingSlot,
  resolveBotAvatarPreset,
} from '../../../web/src/GrokBotAvatar';
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
  /** 与 BotChats 持久化头像键一致（local:local:botId / remote:profileId:deviceId:botId）；
   *  缺省回退 deviceId:botId，仅供无持久化上下文的预览使用。 */
  avatarKey?: string;
  /** 目录侧设备平台徽标；BotRecord 无此字段，由 BotChats 从 devices 目录传入。 */
  devicePlatform?: string;
  /** 会话内搜索关键字；空串显示全部轮次。 */
  search: string;
  archived: boolean;
  onSubmitQuestionnaire: (installationId: string, input: QuestionnaireSubmitPayload) => Promise<unknown>;
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
  avatarKey,
  devicePlatform,
  search,
  archived,
  onSubmitQuestionnaire,
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
      selfBotId: bot.botId,
      liveAttribution,
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

  const activeTurnStartedAt = useMemo(() => resolveActiveTurnStartedAt(allTurns), [allTurns]);
  const lastTurn = visibleTurns.at(-1);

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

  const avatarPreset = resolveBotAvatarPreset(botKey, bot.role, bot.isPrimary);
  const platformBadge = devicePlatform || 'host';

  return (
    <section
      className="desktop-transcript bot-chat-messages"
      ref={scrollRef}
      onScroll={onScroll}
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
          <GrokBotAvatar preset={avatarPreset} isPrimary={bot.isPrimary} starBadge={bot.isPrimary} platformBadge={platformBadge} size={84} />
          <h2>{bot.role}</h2>
          <p>{bot.description || t('开始一段新的对话。', 'Start a new conversation.')}</p>
          {search.trim() ? (
            <p className="desktop-transcript-empty-search">{t('没有匹配搜索的轮次。', 'No turns match the search.')}</p>
          ) : null}
          {emptyActions ? <div className="desktop-transcript-empty-actions">{emptyActions}</div> : null}
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
          // Host 触发器不是人类消息：user-role 的 kind=host 来源（工作触发/内部调度）
          // 不显示来源徽标，避免误认作用户发言；其余真实来源（用户/对端 Bot）照常标记。
          const showAttribution =
            Boolean(turnAttr) && !(turn.role === 'user' && turnAttr?.kind === 'host');
          return (
            <article
              key={turn.id}
              className={`bot-chat-bubble ${turn.role}${turn.isStreaming ? ' streaming' : ''}`}
            >
              {showAttribution && turnAttr ? (
                <MessageAttributionBadge attribution={turnAttr} />
              ) : null}
              {turn.thinking ? (
                <details className="bot-chat-thinking">
                  <summary>{t('思考过程', 'Thinking')}</summary>
                  <pre>{turn.thinking}</pre>
                </details>
              ) : null}
              {turn.tools && turn.tools.length > 0 ? (
                <div className="bot-chat-tools" role="list" aria-label={t('工具调用', 'Tool calls')}>
                  {turn.tools.map((tool) => {
                    const presentation = tool.presentation ? readToolPresentation(tool.presentation) : null;
                    return (
                      <span key={tool.id} role="listitem" className="bot-chat-tool-wrap">
                        <span role="presentation" className={`bot-chat-tool-chip is-${tool.status}`}>
                          <span className="bot-tool-step-icon" aria-hidden="true">
                            {tool.status === 'running' ? (
                              <svg viewBox="0 0 16 16" fill="none">
                                <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeOpacity="0.24" strokeWidth="1.75" />
                                <path d="M8 2.25A5.75 5.75 0 0 1 13.75 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                              </svg>
                            ) : tool.status === 'error' ? (
                              <svg viewBox="0 0 16 16" fill="none">
                                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
                                <path d="M8 5v3.5M8 11h.01" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 16 16" fill="none">
                                <path d="M3.75 8.25 6.6 11.1 12.25 5.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </span>
                          <span className="bot-tool-step-name">{tool.name}</span>
                          <span className="bot-tool-step-state">
                            {tool.status === 'running'
                              ? t('调用中', 'Calling')
                              : tool.status === 'error'
                                ? t('失败', 'Failed')
                                : t('已完成', 'Done')}
                          </span>
                        </span>
                        {presentation ? (
                          <ToolPresentationCard
                            key={`${botKey}:${presentation.kind === 'questionnaire' ? presentation.requestId : tool.id}`}
                            presentation={presentation}
                            active={tool.presentationLive === true && isBusy && !archived}
                            disabled={archived}
                            onSubmit={
                              presentation.kind === 'questionnaire'
                                ? (input) => onSubmitQuestionnaire(presentation.installationId, input)
                                : undefined
                            }
                          />
                        ) : null}
                      </span>
                    );
                  })}
                </div>
              ) : null}
              {turn.role === 'user' && turn.attachments && turn.attachments.length > 0 ? (
                <SentAttachments attachments={turn.attachments} fetcher={attachmentFetcher} />
              ) : null}
              {turn.text ? <Markdown text={turn.text} onOpenLink={openLink} /> : null}
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

      <GrokBotWorkingSlot
        key={botKey}
        botKey={botKey}
        preset={avatarPreset}
        isBusy={isBusy}
        isStreaming={Boolean(displayGeneratingText)}
        activeToolName={activeLiveToolName}
        hasThinking={Boolean(lastTurn?.role === 'assistant' && lastTurn.thinking && !displayGeneratingText)}
        queuedCount={live?.queuedCount ?? 0}
        hasError={Boolean(lastTurn?.error)}
        startedAt={activeTurnStartedAt}
        t={t}
      />
      <ErrorNotice error={linkError} onDismiss={() => setLinkError('')} compact />
    </section>
  );
}
