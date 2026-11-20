import { useCallback, useEffect, useRef, type CSSProperties, type RefObject, type UIEvent } from 'react';
import {
  Archive,
  ArrowLeft,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Star,
  Trash2,
  User,
  X,
  Zap,
} from 'lucide-react';
import type { HostSubmission, TurnDeliveryMode } from '../native';
import { mobileHaptic } from '../native/tauri-host';
import { useCenterConnection } from '../native/CenterGate';
import type { DesktopDraftEntry, DesktopPanelApi } from '../../../desktop/web/src/types';
import type { BotLiveState, ImageAttachment } from '../../../host-core/index.js';
import { isWebhookAttribution, MessageAttribution } from '../MessageAttribution';
import { Markdown } from '../Markdown';
import type { FormattedBotModel } from '../bot-settings/modelDisplay';
import {
  GrokBotAvatar,
  GrokBotFailureRow,
  GrokBotWorkingSlot,
  resolveBotAvatarPreset,
} from '../GrokBotAvatar';
import { botAvatarKey } from '../botAvatarSync';
import { isBotActivityBusy, type BotActivity } from '../botActivity';
import { ChatTurnMeta } from '../ChatTurnMeta';
import {
  hasAssistantVisibleContent,
  resolveAssistantFailureDetail,
  type ChatTurn,
  type ChatTurnBlock,
} from '../chatTurnModel';
import {
  isEditablePrimaryUserTurn,
  type UnifiedQueuedStripItem,
} from '../composerFlowControl';
import { ComposerEditBanner, PendingQueueStrip } from '../ComposerFlowStrips';
import type { QuestionnaireSubmitPayload, VaultUnlockSubmitPayload } from '../ToolPresentation';
import {
  IMAGE_MAX_COUNT,
  ImageAttachmentThumb,
  SentAttachments,
  extractPastedImageFiles,
  type AttachmentFetcher,
} from '../imageAttachments';
import { ErrorNotice, FloatingPillToast, useText } from '../ui';
import { SendButtonIcon } from '../SendButtonIcon';
import {
  TaskChatPromptBanner,
  type BotChatTaskContextResult,
  type TaskBotOption,
} from '../tasks';
import {
  PlatformLogoIcon,
  TurnToolCallsSection,
  formatArchivedRemainingDays,
  type SlashCommandName,
  type TurnAdmissionStatus,
  type useSlashAutocomplete,
} from '../hub/shared';
import { RemotePendingComposer } from './RemotePendingComposer';
import {
  isCoarsePointer,
  type ActionController,
  type ActiveEditingTurn,
  type BubbleActionTurnState,
  type ChatPending,
  type MobileBotItem,
  type PendingTaskChatAction,
  type RemoteTaskContext,
} from './types';

export interface ChatScreenProps {
  visible: boolean;
  anyDrawerOpen: boolean;
  activeBot: MobileBotItem;
  activeChatScope: string;
  hasRemoteConfigured: boolean;
  remoteConnected: boolean;
  activeBotModelSummary: FormattedBotModel | null;
  coarsePointer: boolean;
  inTauriUi: boolean;
  collapseToolOutput: boolean;
  hideToolOutput: boolean;
  botPanelConnected: boolean;
  toolScopeKey: string;
  action: ActionController;

  // Header & menu
  chatTopMenuOpen: boolean;
  onToggleChatTopMenu(): void;
  onCloseChatTopMenu(): void;
  onBack(): void;
  onOpenBotProfile(bot: MobileBotItem): void;
  onOpenBotDmList(bot: MobileBotItem): void;
  onSetPrimaryBot(bot: MobileBotItem): void;
  onRequestArchiveBot(bot: MobileBotItem): void;
  onUnarchiveBot(bot: MobileBotItem): void;
  onRequestDeleteBot(bot: MobileBotItem): void;
  onOpenClearConfirm(): void;

  // Search
  chatSearchOpen: boolean;
  chatSearchQuery: string;
  chatSearchActive: boolean;
  onToggleChatSearch(): void;
  onChangeChatSearchQuery(next: string): void;
  onCloseChatSearch(): void;

  // Messages & scroll
  chatScrollRef: RefObject<HTMLDivElement | null>;
  onMessagesScroll(e: UIEvent<HTMLElement>): void;
  onCancelJumpToBottom(): void;
  chatHistoryLoading: boolean;
  visibleTurns: ChatTurn[];
  latestTurn: ChatTurn | undefined;
  latestTurnHasError: boolean;
  activeEditing: ActiveEditingTurn | null;
  canEditHistoryTurn: boolean;
  isBotBusy: boolean;
  rawBotActivity: BotActivity;
  botActivity: BotActivity;
  sendingOptimistic: boolean;
  sendingReceipt: boolean;
  displayGeneratingText: string;
  displayLiveToolName: string | null | undefined;
  activityFailure: string | undefined;
  effectiveFailureNotice: string | undefined;
  activeTurnStartedAt: number | null | undefined;
  slotFailure: { detail?: string } | undefined;
  effectiveChatLive: BotLiveState | undefined;
  chatPending: ChatPending | undefined;
  chatReceipt: HostSubmission | undefined;
  receiptUserCancelled: boolean;
  submissionInCurrentEpoch: boolean;
  chatTurnAdmission: TurnAdmissionStatus | null;
  chatStatusKind: 'admission' | 'conn' | 'load' | 'clear' | null;
  chatAdmissionText: string;
  chatLoadError: string;
  clearNotice: string;
  chatHasNewContent: boolean;
  onJumpToLatest(): void;
  onOpenLearnedSkills(): void;
  onOpenCenterSettings(): void;

  // Turn actions & attachments
  turnAttachmentFetcher: AttachmentFetcher | null;
  onStartEditTurn(turn: ChatTurn): void;
  onOpenBubbleActions(state: BubbleActionTurnState): void;
  onSubmitQuestionnaire(installationId: string, input: QuestionnaireSubmitPayload): Promise<unknown>;
  onSubmitVaultUnlock(input: VaultUnlockSubmitPayload): Promise<unknown>;

  // Admission & stop actions
  canStopBot: boolean;
  isStoppingBot: boolean;
  queueActionBusy: boolean;
  stopError: string;
  onClearStopError(): void;
  onRetryAdmission(): void;
  onRetryRemoteAdmission(): void;
  onRestoreFailedAdmission(requestId: string): void;
  onStopBot(bot: MobileBotItem): void;

  // Tasks integration
  taskScopeKey: string;
  taskActionFailures: Record<string, PendingTaskChatAction>;
  retryingTaskActionKey: string | null;
  onRetryTaskChatAction(failure: PendingTaskChatAction): void;
  onDismissTaskChatAction(failure: PendingTaskChatAction): void;
  activeBotTaskContext: BotChatTaskContextResult;
  taskBotOptions: TaskBotOption[];
  taskBannerBusy: boolean;
  onOpenTaskDetail(taskId: string, openEdit?: boolean): void;
  onConfirmTaskPlanFromTurn(taskId: string): Promise<void>;
  onAnswerTaskPromptFromTurn(taskId: string, answer: string): Promise<void>;
  onConfirmTaskPlanFromBanner(taskId: string): Promise<void>;
  onAnswerTaskPromptFromBanner(taskId: string, answer: string): Promise<void>;
  onClearJumpedTaskQuote(): void;
  onCycleWaitingTask(): void;

  // Composer (shared + remote + local)
  offlineNotice: { botKey: string; text: string } | undefined;
  onDismissOfflineNotice(): void;
  onShowOfflineNotice(text: string): void;
  remoteApi: DesktopPanelApi | null;
  chatDraft: string;
  slashBusy: SlashCommandName | undefined;
  composerMenuOpen: boolean;
  onToggleComposerMenu(): void;
  onCloseComposerMenu(): void;
  onChangeEditTurn(patch: Partial<Pick<ActiveEditingTurn, 'text' | 'attachments'>>): void;
  onCancelEditTurn(): void;
  onSubmitEditedTurn(): void;
  onRunSlashCommand(command: SlashCommandName): Promise<boolean>;
  onAbortRemote(): Promise<unknown>;
  onRemoteFallbackTransferred(): void;
  onRemoteStarted(requestId: string, text: string, draft: DesktopDraftEntry, delivery?: TurnDeliveryMode): void;
  onRemotePersist(requestId: string): boolean;
  onRemoteQueued(requestId: string, pendingId: string): void;
  onRemoteAccepted(receipt: HostSubmission): void;
  onRemoteUnconfirmed(requestId: string): void;
  onRemoteNotSent(requestId: string): void;
  onForceScrollBottom(): void;
  pendingRemoteQuote: { seq: number; text: string } | null;
  onConsumedRemoteQuote(): void;
  onTaskMessageSent(rawText: string, capturedContext?: RemoteTaskContext): void;

  // Local composer specifics
  slash: ReturnType<typeof useSlashAutocomplete>;
  composerImageError: string;
  onDismissComposerImageError(): void;
  imageUploading: boolean;
  onPickLocalImages(source: 'photos' | 'camera', pastedFiles?: File[]): void;
  localQueuedStripItems: UnifiedQueuedStripItem[];
  canSteerLocal: boolean;
  onRecallLocalQueuedItem(item: UnifiedQueuedStripItem, mergeIntoDraft: boolean): void;
  onRecallAllLocalQueued(): void;
  onSteerLocalQueuedItem(item: UnifiedQueuedStripItem): void;
  editSubmitting: boolean;
  effectiveLocalDraft: string;
  effectiveLocalAttachments: ImageAttachment[];
  localAttachmentFetcher: AttachmentFetcher | null;
  onRemoveLocalAttachment(index: number): void;
  onChangeLocalDraft(next: string): void;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  voiceCapturing: { botId: string; requestId: string } | undefined;
  voicePartialText: string;
  voiceLevel: number;
  onToggleVoiceCapture(): void;
  isPreLlmChat: boolean;
  isStoppingChat: boolean;
  isLlmRunningChat: boolean;
  showLocalComposerStop: boolean;
  isDeletingActiveBot: boolean;
  onSendMessage(delivery: TurnDeliveryMode): void;
}

export function ChatScreen({
  visible,
  anyDrawerOpen,
  activeBot,
  activeChatScope,
  hasRemoteConfigured,
  remoteConnected,
  activeBotModelSummary,
  coarsePointer,
  inTauriUi,
  collapseToolOutput,
  hideToolOutput,
  botPanelConnected,
  toolScopeKey,
  action,
  chatTopMenuOpen,
  onToggleChatTopMenu,
  onCloseChatTopMenu,
  onBack,
  onOpenBotProfile,
  onOpenBotDmList,
  onSetPrimaryBot,
  onRequestArchiveBot,
  onUnarchiveBot,
  onRequestDeleteBot,
  onOpenClearConfirm,
  chatSearchOpen,
  chatSearchQuery,
  chatSearchActive,
  onToggleChatSearch,
  onChangeChatSearchQuery,
  onCloseChatSearch,
  chatScrollRef,
  onMessagesScroll,
  onCancelJumpToBottom,
  chatHistoryLoading,
  visibleTurns,
  latestTurn,
  latestTurnHasError,
  activeEditing,
  canEditHistoryTurn,
  isBotBusy,
  rawBotActivity,
  botActivity,
  sendingOptimistic,
  sendingReceipt,
  displayGeneratingText,
  displayLiveToolName,
  activityFailure,
  effectiveFailureNotice,
  activeTurnStartedAt,
  slotFailure,
  effectiveChatLive,
  chatPending,
  chatReceipt,
  receiptUserCancelled,
  submissionInCurrentEpoch,
  chatTurnAdmission,
  chatStatusKind,
  chatAdmissionText,
  chatLoadError,
  clearNotice,
  chatHasNewContent,
  onJumpToLatest,
  onOpenLearnedSkills,
  onOpenCenterSettings,
  turnAttachmentFetcher,
  onStartEditTurn,
  onOpenBubbleActions,
  onSubmitQuestionnaire,
  onSubmitVaultUnlock,
  canStopBot,
  isStoppingBot,
  queueActionBusy,
  stopError,
  onClearStopError,
  onRetryAdmission,
  onRetryRemoteAdmission,
  onRestoreFailedAdmission,
  onStopBot,
  taskScopeKey,
  taskActionFailures,
  retryingTaskActionKey,
  onRetryTaskChatAction,
  onDismissTaskChatAction,
  activeBotTaskContext,
  taskBotOptions,
  taskBannerBusy,
  onOpenTaskDetail,
  onConfirmTaskPlanFromTurn,
  onAnswerTaskPromptFromTurn,
  onConfirmTaskPlanFromBanner,
  onAnswerTaskPromptFromBanner,
  onClearJumpedTaskQuote,
  onCycleWaitingTask,
  offlineNotice,
  onDismissOfflineNotice,
  onShowOfflineNotice,
  remoteApi,
  chatDraft,
  slashBusy,
  composerMenuOpen,
  onToggleComposerMenu,
  onCloseComposerMenu,
  onChangeEditTurn,
  onCancelEditTurn,
  onSubmitEditedTurn,
  onRunSlashCommand,
  onAbortRemote,
  onRemoteFallbackTransferred,
  onRemoteStarted,
  onRemotePersist,
  onRemoteQueued,
  onRemoteAccepted,
  onRemoteUnconfirmed,
  onRemoteNotSent,
  onForceScrollBottom,
  pendingRemoteQuote,
  onConsumedRemoteQuote,
  onTaskMessageSent,
  slash,
  composerImageError,
  onDismissComposerImageError,
  imageUploading,
  onPickLocalImages,
  localQueuedStripItems,
  canSteerLocal,
  onRecallLocalQueuedItem,
  onRecallAllLocalQueued,
  onSteerLocalQueuedItem,
  editSubmitting,
  effectiveLocalDraft,
  effectiveLocalAttachments,
  localAttachmentFetcher,
  onRemoveLocalAttachment,
  onChangeLocalDraft,
  composerTextareaRef,
  voiceCapturing,
  voicePartialText,
  voiceLevel,
  onToggleVoiceCapture,
  isPreLlmChat,
  isStoppingChat,
  isLlmRunningChat,
  showLocalComposerStop,
  isDeletingActiveBot,
  onSendMessage,
}: ChatScreenProps) {
  const t = useText();
  const centerConn = useCenterConnection();
  const bubbleLongPressRef = useRef<{ timer: number | null; startX: number; startY: number }>({
    timer: null,
    startX: 0,
    startY: 0,
  });

  const cancelBubbleLongPress = useCallback(() => {
    if (bubbleLongPressRef.current.timer !== null) {
      window.clearTimeout(bubbleLongPressRef.current.timer);
      bubbleLongPressRef.current.timer = null;
    }
  }, []);

  useEffect(() => {
    if (!visible) cancelBubbleLongPress();
  }, [visible, cancelBubbleLongPress]);

  useEffect(() => () => {
    cancelBubbleLongPress();
  }, [cancelBubbleLongPress]);

  const activeBotPreset = resolveBotAvatarPreset(
    botAvatarKey(activeBot),
    activeBot.role,
    activeBot.isPrimary,
  );
  const activeBotBannerTask = activeBotTaskContext.linkedTask;
  const activeBotFocusedStep = activeBotTaskContext.focusedStep;

  return (
    <main
      className={`bot-chat-view grok-page-enter${anyDrawerOpen ? ' is-scaled' : ''}`}
      aria-hidden={!visible || undefined}
      style={visible ? undefined : { display: 'none' }}
    >
      {/* Floating Top Header Bar (15845.jpg) */}
      <header className="grok-chat-floating-header">
        <button
          type="button"
          className="grok-floating-circle-btn grok-chat-header-back"
          aria-label={t('返回', 'Back')}
          onClick={onBack}
        >
          <ArrowLeft size={20} />
        </button>

        {/* Center Bot Pill: tapping opens Bot Profile (15846.jpg / 15867.jpg) */}
        <button
          type="button"
          className="grok-chat-center-pill"
          onClick={() => onOpenBotProfile(activeBot)}
          aria-label={t('查看 Bot 资料与设定', 'View Bot profile & settings')}
        >
          <GrokBotAvatar
            preset={activeBotPreset}
            isPrimary={activeBot.isPrimary}
            busy={isBotBusy}
            reflecting={Boolean(effectiveChatLive?.learning?.active)}
            offline={activeBot.online === false}
            size={28}
          />
          <span className="grok-chat-pill-meta">
            <span className="grok-chat-pill-name">{activeBot.role}</span>
            {(hasRemoteConfigured || activeBotModelSummary?.headerText) && (
              <span
                className={`grok-chat-pill-sub${
                  activeBot.online === false
                    ? ' is-danger'
                    : activeBotModelSummary?.tone === 'warn'
                      ? ' is-warn'
                      : ''
                }`}
              >
                {hasRemoteConfigured
                  ? [
                      activeBot.online === false
                        ? `${activeBot.hostLabel} · ${t('离线', 'Offline')}`
                        : activeBot.hostLabel,
                      activeBotModelSummary?.headerText,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : activeBotModelSummary?.headerText}
              </span>
            )}
          </span>
        </button>

        <button
          type="button"
          className="grok-floating-circle-btn grok-chat-header-more"
          aria-label={t('更多选项', 'More options')}
          aria-expanded={chatTopMenuOpen}
          onClick={onToggleChatTopMenu}
        >
          <MoreHorizontal size={20} />
        </button>

        {/* 15845.jpg Dropdown Menu Card */}
        {chatTopMenuOpen && (
          <>
            <div className="grok-menu-backdrop" onClick={onCloseChatTopMenu} />
            <div className="grok-floating-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => onOpenBotProfile(activeBot)}
              >
                <User size={19} />
                <span>{t('查看资料', 'View Profile')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => onOpenBotDmList(activeBot)}
              >
                <MessageSquare size={19} />
                <span>{t('查看 Bot 私聊', 'View Bot DMs')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onCloseChatTopMenu();
                  onToggleChatSearch();
                }}
              >
                <Search size={19} />
                <span>{t('在聊天中查找', 'Search in Chat')}</span>
              </button>
              {!activeBot.isPrimary && !activeBot.archivedAt && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => onSetPrimaryBot(activeBot)}
                >
                  <Star size={19} />
                  <span>{t('设为主 Bot', 'Set as Primary Bot')}</span>
                </button>
              )}
              {!activeBot.isPrimary && !activeBot.archivedAt && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => onRequestArchiveBot(activeBot)}
                >
                  <Archive size={19} />
                  <span>{t('归档 Bot', 'Archive Bot')}</span>
                </button>
              )}
              {Boolean(activeBot.archivedAt) && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => onUnarchiveBot(activeBot)}
                >
                  <RotateCcw size={19} />
                  <span>{t('恢复 Bot', 'Unarchive Bot')}</span>
                </button>
              )}
              {!activeBot.isPrimary && (
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => onRequestDeleteBot(activeBot)}
                >
                  <Trash2 size={19} />
                  <span>{t('永久删除 Bot', 'Permanently Delete Bot')}</span>
                </button>
              )}
              {!activeBot.archivedAt && (
                <>
                  <div className="grok-menu-separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      onCloseChatTopMenu();
                      onOpenClearConfirm();
                    }}
                  >
                    <Trash2 size={19} />
                    <span>{t('清空当前对话', 'Clear History')}</span>
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </header>

      {chatSearchOpen && (
        <div className="grok-chat-search-strip">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={chatSearchQuery}
            onChange={e => onChangeChatSearchQuery(e.target.value)}
            placeholder={t('查找聊天内容…', 'Search messages…')}
            aria-label={t('查找聊天内容', 'Search messages')}
            autoFocus
          />
          <button
            type="button"
            aria-label={t('关闭搜索', 'Close search')}
            onClick={onCloseChatSearch}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      <section
        className="bot-chat-messages"
        ref={chatScrollRef}
        onScroll={onMessagesScroll}
        onWheel={onCancelJumpToBottom}
        onTouchStart={onCancelJumpToBottom}
        onClick={() => {
          if (composerMenuOpen) onCloseComposerMenu();
          if (chatTopMenuOpen) onCloseChatTopMenu();
        }}
      >
        {visibleTurns.length === 0 && chatHistoryLoading && !displayGeneratingText ? (
          <div
            className="bot-chat-skeleton"
            role="status"
            aria-label={t('正在加载历史消息…', 'Loading message history…')}
          >
            <div className="bot-chat-skeleton-bar is-short" aria-hidden="true" />
            <div className="bot-chat-skeleton-bar is-wide" aria-hidden="true" />
            <div className="bot-chat-skeleton-bar is-medium" aria-hidden="true" />
          </div>
        ) : visibleTurns.length === 0 && chatSearchActive ? (
          <div className="bot-chat-search-empty" role="status">
            {t('没有匹配的消息', 'No matching messages')}
          </div>
        ) : visibleTurns.length === 0 && !displayGeneratingText ? (
          <div className="bot-chat-empty">
            <button
              type="button"
              className="bot-chat-empty-avatar-btn"
              onClick={() => onOpenBotProfile(activeBot)}
            >
              <GrokBotAvatar
                preset={activeBotPreset}
                isPrimary={activeBot.isPrimary}
                starBadge={activeBot.isPrimary}
                platformBadge={<PlatformLogoIcon platform={activeBot.platform} size={11} />}
                size={76}
              />
            </button>
            <h2>{activeBot.role}</h2>
            <p>
              {activeBot.description ||
                t('点击顶部名称可管理头像、人设、定时任务与电脑屏幕。',
                  'Tap the top pill to manage avatar, persona, schedules, and computer screen.')}
            </p>
          </div>
        ) : (() => {
          const editingTargetIdx = activeEditing
            ? visibleTurns.findIndex(item => item.role === 'user' && item.entryId === activeEditing.entryId)
            : -1;
          return visibleTurns.map((turn, turnIdx) => {
            const isLastTurn = turnIdx === visibleTurns.length - 1;
            const isLastAssistantTurn = turn.role === 'assistant' && isLastTurn;
            const isStreamingTurn =
              Boolean(turn.isStreaming) || (isLastTurn && (isBotBusy || Boolean(displayGeneratingText)));
            const showTurnDuration =
              turn.role === 'assistant' &&
              typeof turn.durationMs === 'number' &&
              turn.durationMs > 0 &&
              !(isLastAssistantTurn && isBotBusy);
            const attribution = turn.attribution;
            const isEditingTarget = editingTargetIdx === turnIdx;
            const isAfterEditingTarget = editingTargetIdx !== -1 && turnIdx > editingTargetIdx;
            const turnEditable = canEditHistoryTurn && isEditablePrimaryUserTurn(turn);
            const copyText = turn.text;
            const isAssistantFailure = turn.role === 'assistant' && Boolean(turn.error);
            const canRetryTurn = isLastTurn && chatTurnAdmission?.phase === 'failed';
            const showArticle = !isAssistantFailure || hasAssistantVisibleContent(turn);
            const isUserBubble = turn.role === 'user' && !isWebhookAttribution(attribution) && attribution?.kind !== 'bot';
            const failureDetail = isAssistantFailure ? resolveAssistantFailureDetail(
              turn.error === 'model_error' && turn.id === latestTurn?.id && activityFailure
                ? activityFailure : turn.error,
              t,
            ) : '';
            const hasBubbleActions = Boolean(copyText.trim() || turnEditable || canRetryTurn);
            return (
              <div key={turn.id} className={`bot-chat-turn${isStreamingTurn ? ' is-streaming' : ''}`}>
                {showArticle ? (
                  <article
                    className={`bot-chat-bubble ${isWebhookAttribution(attribution) ? 'assistant' : turn.role}${turn.role === 'user' && attribution?.kind === 'bot' ? ' is-peer' : ''}${turn.isStreaming ? ' streaming' : ''}${isEditingTarget ? ' is-editing-target' : ''}${isAfterEditingTarget ? ' is-editing-after' : ''}`}
                    onPointerDown={coarsePointer && hasBubbleActions ? e => {
                      if (e.button !== 0 && e.pointerType === 'mouse') return;
                      if ((e.target as HTMLElement | null)?.closest('a, button, input, textarea, select, details, summary, img')) return;
                      cancelBubbleLongPress();
                      bubbleLongPressRef.current.startX = e.clientX;
                      bubbleLongPressRef.current.startY = e.clientY;
                      bubbleLongPressRef.current.timer = window.setTimeout(() => {
                        bubbleLongPressRef.current.timer = null;
                        if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;
                        mobileHaptic('longPress');
                        if (composerMenuOpen) onCloseComposerMenu();
                        if (chatTopMenuOpen) onCloseChatTopMenu();
                        onOpenBubbleActions({ turn, editable: turnEditable, canRetry: canRetryTurn });
                      }, 450);
                    } : undefined}
                    onPointerMove={coarsePointer && hasBubbleActions ? e => {
                      if (bubbleLongPressRef.current.timer === null) return;
                      if (Math.hypot(e.clientX - bubbleLongPressRef.current.startX, e.clientY - bubbleLongPressRef.current.startY) > 10) {
                        cancelBubbleLongPress();
                      }
                    } : undefined}
                    onPointerUp={coarsePointer && hasBubbleActions ? cancelBubbleLongPress : undefined}
                    onPointerCancel={coarsePointer && hasBubbleActions ? cancelBubbleLongPress : undefined}
                    onPointerLeave={coarsePointer && hasBubbleActions ? cancelBubbleLongPress : undefined}
                  >
                    {attribution && (
                      <MessageAttribution
                        attribution={attribution}
                        className="bot-chat-attribution"
                      />
                    )}
                    {turn.role === 'assistant' ? (
                      turn.blocks ? (
                        turn.blocks.map((block: ChatTurnBlock) =>
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
                              presentationOnly={hideToolOutput}
                              scopeKey={toolScopeKey}
                              active={isBotBusy}
                              disabled={Boolean(activeBot.archivedAt) || !botPanelConnected}
                              onSubmitQuestionnaire={onSubmitQuestionnaire}
                              onSubmitVaultUnlock={onSubmitVaultUnlock}
                              onOpenTask={onOpenTaskDetail}
                              onConfirmTaskPlan={onConfirmTaskPlanFromTurn}
                              onAnswerTaskPrompt={onAnswerTaskPromptFromTurn}
                              t={t}
                            />
                          ) : (
                            <Markdown key={block.id} text={block.text} />
                          ),
                        )
                      ) : (
                        <>
                          {turn.thinking && (
                            <details className="bot-chat-thinking">
                              <summary>{t('思考过程', 'Thinking')}</summary>
                              <pre>{turn.thinking}</pre>
                            </details>
                          )}
                          {turn.tools && turn.tools.length > 0 && (
                            <TurnToolCallsSection
                              tools={turn.tools}
                              collapseOutput={collapseToolOutput}
                              presentationOnly={hideToolOutput}
                              scopeKey={toolScopeKey}
                              active={isBotBusy}
                              disabled={Boolean(activeBot.archivedAt) || !botPanelConnected}
                              onSubmitQuestionnaire={onSubmitQuestionnaire}
                              onSubmitVaultUnlock={onSubmitVaultUnlock}
                              onOpenTask={onOpenTaskDetail}
                              onConfirmTaskPlan={onConfirmTaskPlanFromTurn}
                              onAnswerTaskPrompt={onAnswerTaskPromptFromTurn}
                              t={t}
                            />
                          )}
                          {turn.text && <Markdown text={turn.text} />}
                        </>
                      )
                    ) : null}
                    {turn.role === 'user' && turn.attachments && turn.attachments.length > 0 ? (
                      <SentAttachments
                        attachments={turn.attachments}
                        fetcher={turnAttachmentFetcher}
                      />
                    ) : null}
                    {turn.role === 'user' && turn.text && <Markdown text={turn.text} />}
                  </article>
                ) : null}
                {isAssistantFailure ? (
                  <GrokBotFailureRow
                    botKey={activeBot.key}
                    preset={activeBotPreset}
                    detail={failureDetail || undefined}
                    inline
                    t={t}
                  />
                ) : null}
                {turnEditable && !coarsePointer ? (
                  <div className={`bot-chat-turn-footer${isUserBubble ? ' is-user' : ''}`}>
                    <ChatTurnMeta
                      timestamp={turn.timestamp}
                      durationMs={showTurnDuration ? turn.durationMs : undefined}
                      copyText={copyText}
                    />
                    <button
                      type="button"
                      className="bot-chat-turn-edit-btn"
                      aria-label={t('编辑消息', 'Edit message')}
                      onClick={() => onStartEditTurn(turn)}
                    >
                      <Pencil size={12} aria-hidden="true" />
                      <span>{t('编辑', 'Edit')}</span>
                    </button>
                  </div>
                ) : (
                  <ChatTurnMeta
                    timestamp={turn.timestamp}
                    durationMs={showTurnDuration ? turn.durationMs : undefined}
                    copyText={copyText}
                  />
                )}
              </div>
            );
          });
        })()}
        <GrokBotWorkingSlot
          key={activeBot.key}
          botKey={activeBot.key}
          preset={activeBotPreset}
          isBusy={isBotActivityBusy(botActivity) || Boolean(sendingOptimistic)}
          isSending={Boolean(sendingOptimistic) && !isBotActivityBusy(rawBotActivity)}
          isRecovering={chatPending?.botKey === activeBot.key && chatPending.phase === 'recovering'}
          isStreaming={Boolean(displayGeneratingText)}
          activeToolName={displayLiveToolName}
          hasThinking={Boolean(
            visibleTurns[visibleTurns.length - 1]?.role === 'assistant' &&
              visibleTurns[visibleTurns.length - 1]?.thinking &&
              !displayGeneratingText,
          )}
          queuedCount={effectiveChatLive?.queuedCount ?? 0}
          activity={botActivity}
          learning={effectiveChatLive?.learning ?? null}
          onOpenLearnedSkills={onOpenLearnedSkills}
          hasError={latestTurnHasError || rawBotActivity.phase === 'failed' || Boolean(effectiveFailureNotice) || (chatReceipt?.status === 'unanswered' && !receiptUserCancelled && submissionInCurrentEpoch)}
          startedAt={activeTurnStartedAt}
          failure={slotFailure}
          t={t}
        />

        {chatStatusKind === 'admission' && (
          <div className="bot-chat-system-notice" role="status">
            {chatAdmissionText}
            {chatTurnAdmission?.source === 'background' ? t(' · 后台', ' · background') : null}
            {chatTurnAdmission?.phase === 'failed' && (
              <>
                {activeBot.hostKind === 'local'
                  ? <button type="button" className="hub-outline-btn" onClick={onRetryAdmission}>{t('重试发送', 'Retry sending')}</button>
                  : <button type="button" className="hub-outline-btn" onClick={onRetryRemoteAdmission}>{t('重试发送', 'Retry sending')}</button>}
                {chatTurnAdmission.error?.code === 'MODEL_NO_VISION' && (
                  <button type="button" className="hub-outline-btn" onClick={() => onOpenBotProfile(activeBot)}>
                    {t('模型设置', 'Model Settings')}
                  </button>
                )}
                <button
                  type="button"
                  className="hub-outline-btn"
                  disabled={isStoppingBot || queueActionBusy}
                  onClick={() => onRestoreFailedAdmission(chatTurnAdmission.requestId)}
                >
                  {t('恢复编辑', 'Restore to edit')}
                </button>
                {canStopBot && (
                  <button
                    type="button"
                    className="hub-outline-btn danger"
                    disabled={isStoppingBot}
                    onClick={() => onStopBot(activeBot)}
                  >
                    {t('取消', 'Cancel')}
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {chatStatusKind === 'conn' && (
          <ErrorNotice
            error={centerConn.error}
            actionLabel={t('去连接', 'Connect')}
            onAction={onOpenCenterSettings}
          />
        )}
        {chatStatusKind === 'load' && (
          <div className="bot-chat-system-notice" role="status">
            {activeBot.online === false ? (remoteConnected ? t('目标节点离线，上线后自动恢复。', 'Target offline; restoring when it returns.') : t('连接已中断，远端设备状态待确认。', 'Connection interrupted; remote device status is unknown.')) : chatLoadError}
          </div>
        )}
        {chatStatusKind === 'clear' && (
          <div className="bot-chat-system-notice" role="status">
            {clearNotice}
          </div>
        )}
      </section>

      {chatHasNewContent && !chatSearchOpen && (
        <div className="bot-chat-jump-anchor">
          <button
            type="button"
            className="bot-chat-jump-latest"
            aria-label={t('跳到最新消息', 'Jump to latest')}
            onClick={onJumpToLatest}
          >
            <span aria-hidden="true">↓</span>
            <span>{t('新消息', 'New messages')}</span>
          </button>
        </div>
      )}

      {/* 15845.jpg / 15866.jpg Bottom Composer Bar */}
      {(() => {
        const failureKey = `${taskScopeKey}|${activeBot.deviceId}:${activeBot.botId}`;
        const failure = taskActionFailures[failureKey];
        if (!failure) return null;
        const isRetrying = retryingTaskActionKey === failureKey;
        return (
          <ErrorNotice
            compact
            tone="danger"
            title={
              failure.kind === 'answer_prompt'
                ? t(`任务「${failure.taskTitle}」澄清答复未同步`, `Clarification sync failed for "${failure.taskTitle}"`)
                : failure.kind === 'confirm_plan'
                  ? t(`任务「${failure.taskTitle}」确认计划失败`, `Plan confirmation failed for "${failure.taskTitle}"`)
                  : t(`任务「${failure.taskTitle}」任务备注未同步`, `Task note sync failed for "${failure.taskTitle}"`)
            }
            description={
              failure.kind === 'confirm_plan'
                ? failure.error
                : t(`聊天消息已发送，请仅重试任务动作（勿重发聊天）：${failure.error}`, `Chat message was already sent; retry task action only: ${failure.error}`)
            }
            actionLabel={isRetrying ? t('重试中…', 'Retrying…') : t('仅重试任务动作', 'Retry Task Action')}
            onAction={() => {
              if (isRetrying) return;
              onRetryTaskChatAction(failure);
            }}
            secondaryActionLabel={t('忽略', 'Dismiss')}
            onSecondaryAction={() => onDismissTaskChatAction(failure)}
          />
        );
      })()}
      <TaskChatPromptBanner
        variant="mobile"
        botDeviceId={activeBot.deviceId}
        botId={activeBot.botId}
        task={activeBotBannerTask}
        focusedStep={activeBotFocusedStep}
        showQuoteStrip={activeBotTaskContext.showQuoteStrip}
        waitingTasksCount={activeBotTaskContext.waitingTasks.length}
        waitingTaskIndex={activeBotTaskContext.waitingIndex}
        bots={taskBotOptions}
        busy={taskBannerBusy}
        onClearQuote={onClearJumpedTaskQuote}
        onCycleWaitingTask={onCycleWaitingTask}
        onConfirmPlan={onConfirmTaskPlanFromBanner}
        onOpenTaskDetail={onOpenTaskDetail}
        onAnswerPrompt={onAnswerTaskPromptFromBanner}
      />
      <footer className="grok-chat-composer-area">
        {offlineNotice?.botKey === activeBot.key && (
          <FloatingPillToast
            message={offlineNotice.text}
            tone="warning"
            onDismiss={onDismissOfflineNotice}
          />
        )}
        {activeBot.archivedAt ? (
          <div className="grok-card-group composer-archived-banner">
            <span className="composer-archived-banner-text">
              {t(`该 Bot 已归档（14 天保留期剩余 ${formatArchivedRemainingDays(activeBot.archivedAt)} 天），当前为只读历史`,
                `Archived (${formatArchivedRemainingDays(activeBot.archivedAt)}d left of 14d retention) · Read-only history`)}
            </span>
            <div className="composer-archived-banner-actions">
              <button
                type="button"
                className="grok-done-pill-btn"
                disabled={action.busy}
                onClick={() => onUnarchiveBot(activeBot)}
              >
                {t('立即恢复', 'Restore')}
              </button>
              {!activeBot.isPrimary && (
                <button
                  type="button"
                  className="hub-outline-btn danger"
                  disabled={action.busy}
                  onClick={() => onRequestDeleteBot(activeBot)}
                >
                  {t('永久删除 Bot', 'Permanently Delete')}
                </button>
              )}
            </div>
          </div>
        ) : activeBot.hostKind === 'remote' && activeBot.remoteIdentity && remoteApi ? (
          <RemotePendingComposer
            key={activeBot.key}
            api={remoteApi}
            identity={activeBot.remoteIdentity}
            botId={activeBot.botId}
            botRole={activeBot.role}
            activity={botActivity}
            turnAdmission={chatTurnAdmission}
            liveQueuedItems={effectiveChatLive?.queuedItems}
            editingTurn={activeEditing}
            editSubmitting={editSubmitting}
            onChangeEditTurn={onChangeEditTurn}
            onCancelEditTurn={onCancelEditTurn}
            onSubmitEditTurn={onSubmitEditedTurn}
            online={remoteConnected && activeBot.online !== false}
            onOffline={() => onShowOfflineNotice(t('目标离线，草稿已保留。', 'Target offline; draft retained.'))}
            composerMenuOpen={composerMenuOpen}
            onToggleComposerMenu={onToggleComposerMenu}
            onRunCommand={onRunSlashCommand}
            commandBusy={Boolean(slashBusy)}
            canStop={canStopBot}
            stopping={isStoppingBot}
            onAbort={onAbortRemote}
            pending={chatPending?.scopeKey === activeChatScope ? chatPending : undefined}
            fallbackDraft={chatDraft}
            onFallbackTransferred={onRemoteFallbackTransferred}
            blocked={Boolean(chatPending?.scopeKey === activeChatScope && chatPending.phase === 'recovering')}
            onStarted={onRemoteStarted}
            onPersist={onRemotePersist}
            onQueued={onRemoteQueued}
            onAccepted={onRemoteAccepted}
            onUnconfirmed={onRemoteUnconfirmed}
            onNotSent={onRemoteNotSent}
            onUserSend={onForceScrollBottom}
            pendingQuote={pendingRemoteQuote}
            onConsumedQuote={onConsumedRemoteQuote}
            taskContext={{
              scopeKey: taskScopeKey,
              botKey: activeBot.key,
              deviceId: activeBot.deviceId,
              botId: activeBot.botId,
              botRole: activeBot.role,
              linkedTask: activeBotTaskContext.linkedTask,
              prefix: activeBotTaskContext.taskPrefix,
            }}
            onTaskMessageSent={onTaskMessageSent}
          />
        ) : (
          <>
            <ErrorNotice error={stopError || action.error} compact onDismiss={() => { onClearStopError(); action.setError(''); }} />
            {!activeChatScope && <div className="bot-chat-system-notice" role="status">{t('正在读取目标身份…', 'Loading target identity…')}</div>}

            {slash.open && (
              <div id={slash.listboxId} className="bot-slash-popover" role="listbox" aria-label={t('斜杠命令', 'Slash commands')}>
                {slash.matches.map((command, index) => (
                  <div
                    key={command.name}
                    {...slash.optionProps(index)}
                    className={`bot-slash-item${index === slash.activeIndex ? ' active' : ''}`}
                  >
                    <code>{command.name}</code>
                    <span>{t(command.zh, command.en)}</span>
                  </div>
                ))}
              </div>
            )}

            {composerMenuOpen && (
              <div className="bot-plus-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={activeBot.hostKind === 'remote' ? 'is-unsupported' : undefined}
                  aria-disabled={activeBot.hostKind === 'remote' ? 'true' : undefined}
                  disabled={activeBot.hostKind !== 'remote' && (!activeChatScope || effectiveLocalAttachments.length >= IMAGE_MAX_COUNT || imageUploading)}
                  onClick={() => {
                    onCloseComposerMenu();
                    if (activeBot.hostKind === 'remote') {
                      onShowOfflineNotice(t('仅本机 Bot 支持语音/图片', 'Voice / images are only available for local Bots'));
                      return;
                    }
                    onPickLocalImages('photos');
                  }}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <circle cx="8.5" cy="10.5" r="1.5" />
                    <path d="m21 15-4.5-4.5L9 18" />
                  </svg>
                  <span>{t('选择图片', 'Choose image')}</span>
                </button>
                {inTauriUi && (
                  <button
                    type="button"
                    role="menuitem"
                    className={activeBot.hostKind === 'remote' ? 'is-unsupported' : undefined}
                    aria-disabled={activeBot.hostKind === 'remote' ? 'true' : undefined}
                    disabled={activeBot.hostKind !== 'remote' && (!activeChatScope || effectiveLocalAttachments.length >= IMAGE_MAX_COUNT || imageUploading)}
                    onClick={() => {
                      onCloseComposerMenu();
                      if (activeBot.hostKind === 'remote') {
                        onShowOfflineNotice(t('仅本机 Bot 支持语音/图片', 'Voice / images are only available for local Bots'));
                        return;
                      }
                      onPickLocalImages('camera');
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                    <span>{t('拍照', 'Camera')}</span>
                  </button>
                )}
                <div className="composer-menu-separator" role="separator" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  disabled={Boolean(activeEditing)}
                  onClick={() => {
                    onCloseComposerMenu();
                    onOpenClearConfirm();
                  }}
                >
                  <Trash2 size={18} />
                  <span>{t('清空当前对话历史 (/clear)', 'Clear conversation history (/clear)')}</span>
                </button>
              </div>
            )}

            {composerImageError ? <ErrorNotice compact error={composerImageError} onDismiss={onDismissComposerImageError} /> : null}
            {!activeEditing && localQueuedStripItems.length > 0 ? (
              <PendingQueueStrip
                items={localQueuedStripItems}
                disabled={queueActionBusy || isStoppingBot}
                canSteer={canSteerLocal}
                onRecall={item => onRecallLocalQueuedItem(item, true)}
                onRecallAll={onRecallAllLocalQueued}
                onDiscard={item => onRecallLocalQueuedItem(item, false)}
                onSteer={canSteerLocal ? onSteerLocalQueuedItem : undefined}
                tr={t}
              />
            ) : null}
            {activeEditing ? (
              <ComposerEditBanner
                disabled={editSubmitting}
                onCancel={onCancelEditTurn}
                tr={t}
              />
            ) : null}
            {effectiveLocalAttachments.length > 0 ? (
              <div className="attachments" role="group" aria-label={t('附件', 'Attachments')}>
                {effectiveLocalAttachments.map((att, index) => (
                  <ImageAttachmentThumb
                    key={att.id}
                    attachment={att}
                    fetcher={localAttachmentFetcher}
                    disabled={!activeChatScope || Boolean(slashBusy) || editSubmitting}
                    onRemove={() => onRemoveLocalAttachment(index)}
                    t={t}
                  />
                ))}
              </div>
            ) : null}

            {voiceCapturing && voiceCapturing.botId === activeBot.botId ? (
              <div
                className="composer-voice-bar"
                role="status"
                aria-live="polite"
                style={{ '--voice-level': String(voiceLevel) } as CSSProperties}
              >
                <span className="composer-voice-wave" aria-hidden="true">
                  <span className="composer-voice-bar-col" />
                  <span className="composer-voice-bar-col" />
                  <span className="composer-voice-bar-col" />
                  <span className="composer-voice-bar-col" />
                  <span className="composer-voice-bar-col" />
                </span>
                <span className={`composer-voice-text${voicePartialText ? '' : ' is-placeholder'}`}>
                  {voicePartialText || t('正在聆听…', 'Listening…')}
                </span>
              </div>
            ) : null}

            <div className="grok-composer-row">
              <button
                type="button"
                className={`grok-composer-plus-circle${composerMenuOpen ? ' active' : ''}`}
                aria-label={t('更多操作', 'More actions')}
                aria-expanded={composerMenuOpen}
                onClick={onToggleComposerMenu}
              >
                <Plus size={22} />
              </button>

              <div className="grok-composer-pill">
                <textarea
                  ref={composerTextareaRef}
                  rows={1}
                  className={effectiveLocalDraft ? 'has-text' : 'is-empty'}
                  value={effectiveLocalDraft}
                  disabled={!activeChatScope || Boolean(slashBusy) || editSubmitting}
                  {...slash.textareaProps}
                  onChange={e => onChangeLocalDraft(e.target.value)}
                  placeholder={
                    activeEditing
                      ? t('修改消息内容…', 'Edit message…')
                      : activeBot.role.length > 8
                        ? t('发消息…', 'Message…')
                        : t(`向 ${activeBot.role} 发消息…`, `Message ${activeBot.role}…`)
                  }
                  aria-label={t('消息', 'Message')}
                  enterKeyHint={coarsePointer ? 'enter' : 'send'}
                  onPaste={e => {
                    const files = extractPastedImageFiles(e.clipboardData);
                    if (files.length === 0) return;
                    if (!e.clipboardData?.getData('text/plain')?.trim()) {
                      e.preventDefault();
                    }
                    onPickLocalImages('photos', files);
                  }}
                  onKeyDown={e => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === 'Escape' && activeEditing && !editSubmitting) {
                      e.preventDefault();
                      onCancelEditTurn();
                      return;
                    }
                    if (e.altKey && e.key === 'ArrowUp' && !activeEditing && localQueuedStripItems.length > 0 && !queueActionBusy) {
                      e.preventDefault();
                      onRecallLocalQueuedItem(localQueuedStripItems[localQueuedStripItems.length - 1], true);
                      return;
                    }
                    if (slash.onKeyDown(e)) return;
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      if (activeEditing) onSubmitEditedTurn();
                      else if (!isPreLlmChat && !isStoppingChat) onSendMessage(canSteerLocal ? 'steer' : 'followUp');
                      return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey && !isCoarsePointer()) {
                      e.preventDefault();
                      if (activeEditing) onSubmitEditedTurn();
                      else if (!isPreLlmChat && !isStoppingChat) onSendMessage('followUp');
                    }
                  }}
                />

                {!activeEditing && (voiceCapturing || !((isLlmRunningChat || showLocalComposerStop) && (Boolean(effectiveLocalDraft.trim()) || effectiveLocalAttachments.length > 0))) && (
                  activeBot.hostKind === 'local' ? (
                    <button
                      type="button"
                      className={`grok-composer-mic-inline${voiceCapturing ? ' recording' : ''}`}
                      aria-label={voiceCapturing ? t('完成语音', 'Finish voice') : t('语音输入', 'Voice input')}
                      disabled={!voiceCapturing && (isPreLlmChat || isStoppingChat)}
                      onClick={onToggleVoiceCapture}
                    >
                      <Mic size={19} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="grok-composer-mic-inline is-unsupported"
                      aria-disabled="true"
                      aria-label={t('仅本机 Bot 支持语音/图片', 'Voice / images are only available for local Bots')}
                      title={t('仅本机 Bot 支持语音/图片', 'Voice / images are only available for local Bots')}
                      onClick={() =>
                        onShowOfflineNotice(t('仅本机 Bot 支持语音/图片', 'Voice / images are only available for local Bots'))
                      }
                    >
                      <Mic size={19} />
                    </button>
                  )
                )}

                <div className="grok-composer-actions">
                  {isStoppingChat ? (
                    <button
                      type="button"
                      className="grok-composer-action-pill stop"
                      aria-label={t('正在停止…', 'Stopping…')}
                      disabled
                    >
                      <RefreshCw size={14} className="grok-spin" />
                    </button>
                  ) : (
                    <>
                      {!(isPreLlmChat || sendingReceipt || editSubmitting) && (effectiveLocalDraft.trim() || effectiveLocalAttachments.length > 0) ? (
                        <>
                          {!activeEditing && canSteerLocal ? (
                            <button
                              type="button"
                              className="grok-composer-steer-btn"
                              aria-label={t('打断并立即发送', 'Interrupt & send immediately')}
                              title={t('打断并立即发送 (Ctrl+Enter)', 'Interrupt & send immediately (Ctrl+Enter)')}
                              disabled={sendingReceipt || action.busy || Boolean(slashBusy) || imageUploading || isDeletingActiveBot}
                              onClick={() => onSendMessage('steer')}
                            >
                              <Zap size={16} />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="grok-composer-action-pill send"
                            aria-label={activeEditing ? t('保存并重发', 'Save & resend') : isLlmRunningChat ? t('排队发送', 'Queue message') : t('发送', 'Send')}
                            disabled={sendingReceipt || editSubmitting || action.busy || Boolean(slashBusy) || imageUploading || isDeletingActiveBot}
                            onClick={() => {
                              if (activeEditing) onSubmitEditedTurn();
                              else onSendMessage('followUp');
                            }}
                          >
                            <SendButtonIcon busy={false} />
                          </button>
                        </>
                      ) : null}
                      {showLocalComposerStop ? (
                        <button
                          type="button"
                          className="grok-composer-action-pill stop"
                          aria-label={t('停止此 Bot', 'Stop this bot')}
                          onClick={() => {
                            if (isStoppingBot) return;
                            onStopBot(activeBot);
                          }}
                        >
                          <Square size={15} />
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </footer>
    </main>
  );
}
