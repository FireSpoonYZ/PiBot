import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject, type UIEvent } from 'react';
import {
  Archive,
  ArrowLeft,
  ChevronUp,
  Globe,
  MessageSquare,
  Mic,
  MoreHorizontal,
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
import type { ConnectionPhase } from '../connection';
import { useNotice } from '../notice';
import { SmoothExpand, useBottomChromeMeasure } from '../layout';
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
  type GrokWorkingSlotNotice,
  type GrokWorkingSlotNoticeAction,
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
import type {
  GoogleChatCardContext,
  QuestionnaireSubmitPayload,
  VaultUnlockSubmitPayload,
} from '../ToolPresentation';
import { CurrentGoogleSetupCard } from '../google/CurrentGoogleSetupCard';
import type { GoogleSetupPresentation } from '../google/types';
import {
  IMAGE_MAX_COUNT,
  ImageAttachmentThumb,
  SentAttachments,
  extractPastedImageFiles,
  type AttachmentFetcher,
} from '../imageAttachments';
import { humanizeError, useText } from '../ui';
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

const CHAT_CONN_NOTICE_ID = 'chat-conn-issue';
const CHAT_LOAD_NOTICE_ID = 'chat-load-issue';
const CHAT_COMPOSER_ERROR_NOTICE_ID = 'chat-composer-error';
const CHAT_IMAGE_ERROR_NOTICE_ID = 'chat-image-error';
const CHAT_TASK_ACTION_ERROR_NOTICE_ID = 'chat-task-action-error';
const CHAT_OFFLINE_NOTICE_ID = 'chat-offline-notice';

export interface ChatScreenProps {
  visible: boolean;
  anyDrawerOpen: boolean;
  activeBot: MobileBotItem;
  activeChatScope: string;
  hasRemoteConfigured: boolean;
  remoteConnected: boolean;
  connectionPhase: ConnectionPhase;
  connectionDetail: string;
  ipcReconnecting: boolean;
  onRetryConnection(): void;
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
  chatMessagesContentRef: RefObject<HTMLDivElement | null>;
  onMessagesScroll(e: UIEvent<HTMLElement>): void;
  onCancelJumpToBottom?(): void;
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
  googleContext?: GoogleChatCardContext;
  currentGoogleSetup?: GoogleSetupPresentation;
  onOpenBrowser?: () => void;
  browserTakeoverHint?: string | null;

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
  connectionPhase,
  connectionDetail,
  ipcReconnecting,
  onRetryConnection,
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
  chatMessagesContentRef,
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
  googleContext,
  currentGoogleSetup,
  onOpenBrowser,
  browserTakeoverHint,
  canStopBot,
  isStoppingBot,
  queueActionBusy,
  stopError,
  onRetryAdmission,
  onRetryRemoteAdmission,
  onRestoreFailedAdmission,
  onStopBot,
  taskScopeKey,
  taskActionFailures,
  retryingTaskActionKey,
  onRetryTaskChatAction,
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
  const { notify, dismiss } = useNotice();
  const [connPopoverOpen, setConnPopoverOpen] = useState(false);
  const [remoteFloatingDockEl, setRemoteFloatingDockEl] = useState<HTMLDivElement | null>(null);

  const composerAreaRef = useRef<HTMLElement | null>(null);
  useBottomChromeMeasure(composerAreaRef, visible);

  const tRef = useRef(t);
  tRef.current = t;
  const actionsRef = useRef({
    onOpenCenterSettings,
    onRetryTaskChatAction,
  });
  actionsRef.current = {
    onOpenCenterSettings,
    onRetryTaskChatAction,
  };

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

  useEffect(() => {
    if (!visible || connectionPhase === 'online' || chatSearchOpen || chatTopMenuOpen) {
      setConnPopoverOpen(false);
    }
  }, [visible, connectionPhase, chatSearchOpen, chatTopMenuOpen]);

  useEffect(() => {
    if (!connPopoverOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConnPopoverOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [connPopoverOpen]);

  // C7: conn 系统提示走 F1 浮层通知，不插入消息流。
  useEffect(() => {
    const err = visible && chatStatusKind === 'conn' ? centerConn.error.trim() : '';
    if (!err) {
      dismiss(CHAT_CONN_NOTICE_ID);
      return;
    }
    const t = tRef.current;
    const humanized = humanizeError(err, t);
    const title = humanized?.title || t('中心连接异常', 'Center connection error');
    const detailParts = [humanized?.description, humanized?.detail].filter(Boolean);
    notify({
      id: CHAT_CONN_NOTICE_ID,
      tone: 'error',
      title,
      detail: detailParts.length > 0 ? detailParts.join('\n') : err,
      action: {
        label: t('去连接', 'Connect'),
        onClick: () => actionsRef.current.onOpenCenterSettings(),
      },
    });
  }, [visible, chatStatusKind, centerConn.error, activeBot.key, notify, dismiss]);

  // C7: load 系统提示走 F1 浮层通知，不插入消息流。
  const chatLoadMessage = useMemo(() => {
    if (!visible || chatStatusKind !== 'load') return '';
    if (activeBot.online === false) {
      return remoteConnected
        ? t('目标节点离线，上线后自动恢复。', 'Target offline; restoring when it returns.')
        : t('连接已中断，远端设备状态待确认。', 'Connection interrupted; remote device status is unknown.');
    }
    return chatLoadError.trim();
  }, [visible, chatStatusKind, activeBot.online, remoteConnected, chatLoadError, t]);

  useEffect(() => {
    if (!chatLoadMessage) {
      dismiss(CHAT_LOAD_NOTICE_ID);
      return;
    }
    notify({
      id: CHAT_LOAD_NOTICE_ID,
      tone: 'warning',
      title: chatLoadMessage,
    });
  }, [chatLoadMessage, activeBot.key, notify, dismiss]);

  // C6: 本机输入区异步错误（stopError / action.error）走 F1 浮层。
  const isRemoteComposer =
    !activeBot.archivedAt &&
    activeBot.hostKind === 'remote' &&
    Boolean(activeBot.remoteIdentity) &&
    Boolean(remoteApi);
  const composerAsyncError =
    visible && !activeBot.archivedAt && !isRemoteComposer
      ? (stopError || action.error).trim()
      : '';

  useEffect(() => {
    if (!composerAsyncError) {
      dismiss(CHAT_COMPOSER_ERROR_NOTICE_ID);
      return;
    }
    const humanized = humanizeError(composerAsyncError, tRef.current);
    const title = humanized?.title || composerAsyncError;
    const detailParts = [humanized?.description, humanized?.detail].filter(Boolean);
    notify({
      id: CHAT_COMPOSER_ERROR_NOTICE_ID,
      tone: 'error',
      title,
      detail: detailParts.length > 0 ? detailParts.join('\n') : undefined,
    });
  }, [composerAsyncError, activeBot.key, notify, dismiss]);

  // C6: 本机图片上传/选图错误走 F1 浮层。
  const activeImageError =
    visible && !activeBot.archivedAt && !isRemoteComposer ? composerImageError.trim() : '';

  useEffect(() => {
    if (!activeImageError) {
      dismiss(CHAT_IMAGE_ERROR_NOTICE_ID);
      return;
    }
    const humanized = humanizeError(activeImageError, tRef.current);
    const title = humanized?.title || activeImageError;
    const detailParts = [humanized?.description, humanized?.detail].filter(Boolean);
    notify({
      id: CHAT_IMAGE_ERROR_NOTICE_ID,
      tone: 'error',
      title,
      detail: detailParts.length > 0 ? detailParts.join('\n') : undefined,
    });
  }, [activeImageError, activeBot.key, notify, dismiss]);

  // C6: 任务联动动作失败走 F1 浮层，保留「仅重试任务动作」操作。
  const taskFailureKey = `${taskScopeKey}|${activeBot.deviceId}:${activeBot.botId}`;
  const taskFailure = visible ? taskActionFailures[taskFailureKey] : undefined;
  const isRetryingTaskFailure = retryingTaskActionKey === taskFailureKey;
  const taskFailureRef = useRef(taskFailure);
  taskFailureRef.current = taskFailure;

  useEffect(() => {
    if (!taskFailure) {
      dismiss(CHAT_TASK_ACTION_ERROR_NOTICE_ID);
      return;
    }
    const t = tRef.current;
    const title =
      taskFailure.kind === 'answer_prompt'
        ? t(`任务「${taskFailure.taskTitle}」澄清答复未同步`, `Clarification sync failed for "${taskFailure.taskTitle}"`)
        : taskFailure.kind === 'confirm_plan'
          ? t(`任务「${taskFailure.taskTitle}」确认计划失败`, `Plan confirmation failed for "${taskFailure.taskTitle}"`)
          : t(`任务「${taskFailure.taskTitle}」任务备注未同步`, `Task note sync failed for "${taskFailure.taskTitle}"`);
    const detail =
      taskFailure.kind === 'confirm_plan'
        ? taskFailure.error
        : t(`聊天消息已发送，请仅重试任务动作（勿重发聊天）：${taskFailure.error}`, `Chat message was already sent; retry task action only: ${taskFailure.error}`);
    notify({
      id: CHAT_TASK_ACTION_ERROR_NOTICE_ID,
      tone: 'error',
      title,
      detail,
      sticky: true,
      action: {
        label: isRetryingTaskFailure ? t('重试中…', 'Retrying…') : t('仅重试任务动作', 'Retry Task Action'),
        onClick: () => {
          const latest = taskFailureRef.current;
          if (!latest || isRetryingTaskFailure) return;
          actionsRef.current.onRetryTaskChatAction(latest);
        },
      },
    });
  }, [
    taskFailure?.kind,
    taskFailure?.taskId,
    taskFailure?.taskTitle,
    taskFailure?.error,
    isRetryingTaskFailure,
    activeBot.key,
    notify,
    dismiss,
  ]);

  // C6: offlineNotice 走 F1 浮层，替代旧 FloatingPillToast。
  const activeOfflineNoticeText =
    visible && offlineNotice?.botKey === activeBot.key ? offlineNotice.text.trim() : '';

  useEffect(() => {
    if (!activeOfflineNoticeText) {
      dismiss(CHAT_OFFLINE_NOTICE_ID);
      return;
    }
    notify({
      id: CHAT_OFFLINE_NOTICE_ID,
      tone: 'warning',
      title: activeOfflineNoticeText,
      durationMs: 3000,
    });
  }, [activeOfflineNoticeText, activeBot.key, notify, dismiss]);

  useEffect(() => () => {
    dismiss(CHAT_CONN_NOTICE_ID);
    dismiss(CHAT_LOAD_NOTICE_ID);
    dismiss(CHAT_COMPOSER_ERROR_NOTICE_ID);
    dismiss(CHAT_IMAGE_ERROR_NOTICE_ID);
    dismiss(CHAT_TASK_ACTION_ERROR_NOTICE_ID);
    dismiss(CHAT_OFFLINE_NOTICE_ID);
  }, [dismiss]);

  const activeBotPreset = resolveBotAvatarPreset(
    botAvatarKey(activeBot),
    activeBot.role,
    activeBot.isPrimary,
  );
  const activeBotBannerTask = activeBotTaskContext.linkedTask;
  const activeBotFocusedStep = activeBotTaskContext.focusedStep;
  const hasLocalDraft = Boolean(effectiveLocalDraft.trim()) || effectiveLocalAttachments.length > 0;
  const isVoiceActive = Boolean(voiceCapturing);
  const isLocalVoiceActive = Boolean(voiceCapturing && voiceCapturing.botId === activeBot.botId);

  // D2 + C7: admission 失败与 clear 提示放进常驻 44px GrokBotWorkingSlot 槽内就地淡入淡出。
  const workingSlotNotice = useMemo<GrokWorkingSlotNotice | null>(() => {
    if (chatStatusKind === 'admission') {
      const text = `${chatAdmissionText}${chatTurnAdmission?.source === 'background' ? t(' · 后台', ' · background') : ''}`;
      if (!text.trim()) return null;
      const actions: GrokWorkingSlotNoticeAction[] = [];
      if (chatTurnAdmission?.phase === 'failed') {
        actions.push({
          label: t('重试发送', 'Retry sending'),
          onClick: activeBot.hostKind === 'local' ? onRetryAdmission : onRetryRemoteAdmission,
        });
        if (chatTurnAdmission.error?.code === 'MODEL_NO_VISION') {
          actions.push({
            label: t('模型设置', 'Model Settings'),
            onClick: () => onOpenBotProfile(activeBot),
          });
        }
        actions.push({
          label: t('恢复编辑', 'Restore to edit'),
          disabled: isStoppingBot || queueActionBusy,
          onClick: () => onRestoreFailedAdmission(chatTurnAdmission.requestId),
        });
        if (canStopBot) {
          actions.push({
            label: t('取消', 'Cancel'),
            tone: 'danger',
            disabled: isStoppingBot,
            onClick: () => onStopBot(activeBot),
          });
        }
      }
      return {
        id: `admission-${chatTurnAdmission?.requestId ?? 'failed'}`,
        tone: 'danger',
        text,
        actions,
      };
    }
    if (chatStatusKind === 'clear' && clearNotice.trim()) {
      return {
        id: 'chat-clear-notice',
        tone: 'info',
        text: clearNotice,
      };
    }
    return null;
  }, [
    chatStatusKind,
    chatAdmissionText,
    chatTurnAdmission,
    clearNotice,
    activeBot,
    onRetryAdmission,
    onRetryRemoteAdmission,
    onOpenBotProfile,
    onRestoreFailedAdmission,
    canStopBot,
    isStoppingBot,
    queueActionBusy,
    onStopBot,
    t,
  ]);

  const normalSubtitle = hasRemoteConfigured
    ? [
        activeBot.online === false
          ? `${activeBot.hostLabel} · ${t('离线', 'Offline')}`
          : activeBot.hostLabel,
        activeBotModelSummary?.headerText,
      ]
        .filter(Boolean)
        .join(' · ')
    : (activeBotModelSummary?.headerText ?? '');

  const normalSubtitleToneClass =
    activeBot.online === false
      ? ' is-danger'
      : activeBotModelSummary?.tone === 'warn'
        ? ' is-warn'
        : '';

  const connStatusLabel =
    connectionPhase === 'connecting'
      ? t('连接中…', 'Connecting…')
      : connectionPhase === 'offline'
        ? t('离线', 'Offline')
        : t('连接异常', 'Connection issue');

  const connPopoverHeading =
    connectionPhase === 'connecting'
      ? (ipcReconnecting ? t('正在恢复本地服务…', 'Reconnecting local service…') : t('正在恢复连接…', 'Reconnecting…'))
      : connectionPhase === 'offline'
        ? t('与中心未连接', 'Disconnected from center')
        : t('中心连接异常', 'Center connection issue');

  const connPopoverDescription =
    connectionDetail.trim() ||
    (connectionPhase === 'connecting'
      ? t('正在恢复中心与设备连接，请稍候。', 'Restoring center and device connection.')
      : connectionPhase === 'offline'
        ? t('当前与中心未连接，远端消息将在恢复后自动同步。', 'Disconnected from center; remote messages will sync once reconnected.')
        : t('中心连接异常，请前往设置检查连接配置。', 'Center connection error; open Settings to check your configuration.'));

  const showSkeletonState = visibleTurns.length === 0 && chatHistoryLoading && !displayGeneratingText;
  const showSearchEmptyState = visibleTurns.length === 0 && !showSkeletonState && chatSearchActive;
  const showBotEmptyState = visibleTurns.length === 0 && !showSkeletonState && !chatSearchActive && !displayGeneratingText;
  const showEmptyOverlay = showSkeletonState || showSearchEmptyState || showBotEmptyState;

  const showBrowserStrip = Boolean(browserTakeoverHint && onOpenBrowser);
  const showLocalQueueStrip =
    !activeBot.archivedAt &&
    !isRemoteComposer &&
    !activeEditing &&
    localQueuedStripItems.length > 0;

  return (
    <main
      className={`bot-chat-view grok-page-enter${anyDrawerOpen ? ' is-scaled' : ''}`}
      aria-hidden={!visible || undefined}
      style={visible ? undefined : { display: 'none' }}
    >
      {/* Floating Top Header Bar (D1 fixed-height status slot + C7 in-place search) */}
      <header className="grok-chat-floating-header">
        <button
          type="button"
          className="grok-floating-circle-btn grok-chat-header-back"
          aria-label={t('返回', 'Back')}
          onClick={onBack}
        >
          <ArrowLeft size={20} />
        </button>

        {chatSearchOpen ? (
          <div className="grok-chat-header-search" role="search">
            <Search size={15} className="grok-chat-header-search-icon" aria-hidden="true" />
            <input
              type="search"
              value={chatSearchQuery}
              onChange={e => onChangeChatSearchQuery(e.target.value)}
              placeholder={t('查找聊天内容…', 'Search messages…')}
              aria-label={t('查找聊天内容', 'Search messages')}
              autoFocus
            />
            {chatSearchActive ? (
              <span className="grok-chat-header-search-count" aria-live="polite">
                {t(`${visibleTurns.length} 条`, `${visibleTurns.length}`)}
              </span>
            ) : null}
            <button
              type="button"
              className="grok-chat-header-search-close"
              aria-label={t('关闭搜索', 'Close search')}
              onClick={onCloseChatSearch}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="grok-chat-center-pill">
            <button
              type="button"
              className="grok-chat-pill-avatar-btn"
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
            </button>
            <div className="grok-chat-pill-meta">
              <button
                type="button"
                className="grok-chat-pill-name-btn"
                onClick={() => onOpenBotProfile(activeBot)}
                aria-label={t('查看 Bot 资料与设定', 'View Bot profile & settings')}
              >
                <span className="grok-chat-pill-name">{activeBot.role}</span>
              </button>
              <div className="grok-chat-pill-sub-slot">
                {connectionPhase !== 'online' ? (
                  <button
                    type="button"
                    className={`grok-chat-pill-sub is-conn-trigger is-${connectionPhase}`}
                    aria-haspopup="dialog"
                    aria-expanded={connPopoverOpen}
                    aria-label={`${connStatusLabel} - ${t('查看连接详情', 'View connection details')}`}
                    onClick={() => {
                      if (chatTopMenuOpen) onCloseChatTopMenu();
                      setConnPopoverOpen(v => !v);
                    }}
                  >
                    {connectionPhase === 'connecting' ? (
                      <RefreshCw size={11} className="hub-top-status-spin" aria-hidden="true" />
                    ) : (
                      <span className={`hub-top-status-dot is-${connectionPhase}`} aria-hidden="true" />
                    )}
                    <span className="grok-chat-pill-sub-text">{connStatusLabel}</span>
                  </button>
                ) : normalSubtitle ? (
                  <button
                    type="button"
                    className={`grok-chat-pill-sub${normalSubtitleToneClass}`}
                    onClick={() => onOpenBotProfile(activeBot)}
                  >
                    <span className="grok-chat-pill-sub-text">{normalSubtitle}</span>
                  </button>
                ) : (
                  <span className="grok-chat-pill-sub is-empty" aria-hidden="true">&nbsp;</span>
                )}
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          className="grok-floating-circle-btn grok-chat-header-more"
          aria-label={t('更多选项', 'More options')}
          aria-expanded={chatTopMenuOpen}
          onClick={() => {
            setConnPopoverOpen(false);
            onToggleChatTopMenu();
          }}
        >
          <MoreHorizontal size={20} />
        </button>

        {connPopoverOpen && connectionPhase !== 'online' && !chatSearchOpen && (
          <>
            <div className="grok-menu-backdrop" onClick={() => setConnPopoverOpen(false)} />
            <div
              className="hub-conn-popover"
              role="dialog"
              aria-label={t('连接状态详情', 'Connection status details')}
            >
              <div className={`hub-conn-popover-head is-${connectionPhase}`}>
                {connectionPhase === 'connecting' ? (
                  <RefreshCw size={15} className="hub-top-status-spin" aria-hidden="true" />
                ) : (
                  <span className={`hub-top-status-dot is-${connectionPhase}`} aria-hidden="true" />
                )}
                <span>{connPopoverHeading}</span>
              </div>
              <p className="hub-conn-popover-desc">{connPopoverDescription}</p>
              <div className="hub-conn-popover-actions">
                <button
                  type="button"
                  className="hub-conn-popover-btn"
                  onClick={() => {
                    setConnPopoverOpen(false);
                    onRetryConnection();
                  }}
                >
                  {t('立即重试', 'Retry now')}
                </button>
                <button
                  type="button"
                  className="hub-conn-popover-btn is-primary"
                  onClick={() => {
                    setConnPopoverOpen(false);
                    onOpenCenterSettings();
                  }}
                >
                  {t('去设置', 'Settings')}
                </button>
              </div>
            </div>
          </>
        )}

        {/* Dropdown Menu Card */}
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
              {onOpenBrowser ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onCloseChatTopMenu();
                    onOpenBrowser();
                  }}
                >
                  <Globe size={19} />
                  <span>{t('Bot 浏览器', 'Bot Browser')}</span>
                </button>
              ) : null}
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

      <section
        className="bot-chat-messages"
        ref={chatScrollRef}
        onScroll={onMessagesScroll}
        onWheel={onCancelJumpToBottom}
        onTouchStart={onCancelJumpToBottom}
        onClick={() => {
          if (composerMenuOpen) onCloseComposerMenu();
          if (chatTopMenuOpen) onCloseChatTopMenu();
          if (connPopoverOpen) setConnPopoverOpen(false);
        }}
      >
        {/* C7: 骨架屏、搜索无结果与空态统一放在同一绝对定位层内交叉淡入淡出，零布局位移 */}
        <div
          className={`bot-chat-empty-overlay${showEmptyOverlay ? ' is-visible' : ''}`}
          aria-hidden={!showEmptyOverlay || undefined}
        >
          <div
            className={`bot-chat-state-layer${showSkeletonState ? ' is-active' : ''}`}
            role={showSkeletonState ? 'status' : undefined}
            aria-label={showSkeletonState ? t('正在加载历史消息…', 'Loading message history…') : undefined}
            aria-hidden={!showSkeletonState || undefined}
          >
            <div className="bot-chat-skeleton">
              <div className="bot-chat-skeleton-bar is-short" aria-hidden="true" />
              <div className="bot-chat-skeleton-bar is-wide" aria-hidden="true" />
              <div className="bot-chat-skeleton-bar is-medium" aria-hidden="true" />
            </div>
          </div>

          <div
            className={`bot-chat-state-layer${showSearchEmptyState ? ' is-active' : ''}`}
            role={showSearchEmptyState ? 'status' : undefined}
            aria-hidden={!showSearchEmptyState || undefined}
          >
            <div className="bot-chat-search-empty">
              {t('没有匹配的消息', 'No matching messages')}
            </div>
          </div>

          <div
            className={`bot-chat-state-layer is-interactive${showBotEmptyState ? ' is-active' : ''}`}
            aria-hidden={!showBotEmptyState || undefined}
          >
            <div className="bot-chat-empty">
              <button
                type="button"
                className="bot-chat-empty-avatar-btn"
                tabIndex={showBotEmptyState ? 0 : -1}
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
                  t('点击顶部名称可管理头像、人设、定时任务与电脑屏幕。', 'Tap the top pill to manage avatar, persona, schedules, and computer screen.')}
              </p>
            </div>
          </div>
        </div>

        <div ref={chatMessagesContentRef} className="bot-chat-messages-content">
          <div className="bot-chat-turns-list">
            {(() => {
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
                const failureDetail = isAssistantFailure ? resolveAssistantFailureDetail(
                  turn.error === 'model_error' && turn.id === latestTurn?.id && activityFailure
                    ? activityFailure : turn.error,
                  t,
                ) : '';
                const hasBubbleActions = Boolean(copyText.trim() || turnEditable || canRetryTurn);
                return (
                  <div
                    key={turn.id}
                    data-turn-id={turn.id}
                    className={`bot-chat-turn${isStreamingTurn ? ' is-streaming' : ''}`}
                  >
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
                                  googleContext={googleContext}
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
                                  googleContext={googleContext}
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
                    <ChatTurnMeta
                      role={turn.role}
                      timestamp={turn.timestamp}
                      durationMs={showTurnDuration ? turn.durationMs : undefined}
                      copyText={copyText}
                      onEdit={turnEditable && !coarsePointer ? () => onStartEditTurn(turn) : undefined}
                    />
                  </div>
                );
              });
            })()}
          </div>
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
            slotNotice={workingSlotNotice}
            reserveSlot
            t={t}
          />
        </div>
      </section>

      <footer ref={composerAreaRef} className="grok-chat-composer-area">
        {/* C6 + C7: 统一浮层停靠栈（跳回最新、浏览器接管、远端草稿/冲突/排队、本机排队、任务提示），零流内位移且互不遮挡 */}
        <div className="grok-composer-floating-dock">
          {chatHasNewContent && !chatSearchOpen ? (
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
          ) : null}
          {showBrowserStrip && onOpenBrowser ? (
            <button
              type="button"
              className="gws-browser-strip"
              onClick={onOpenBrowser}
              aria-label={t('打开 Bot 浏览器接管页面', 'Open Bot browser to take over')}
            >
              <span className="gws-browser-strip-left">
                <Globe size={16} aria-hidden="true" />
                <span>{browserTakeoverHint}</span>
              </span>
              <ChevronUp size={16} aria-hidden="true" />
            </button>
          ) : null}
          <div ref={setRemoteFloatingDockEl} className="grok-composer-floating-slot" />
          {showLocalQueueStrip ? (
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
        </div>

        <CurrentGoogleSetupCard
          active={visible}
          hostRevision={effectiveChatLive?.googleSetupRevision}
          scopeKey={toolScopeKey}
          presentation={currentGoogleSetup}
          googleContext={googleContext}
          disabled={Boolean(activeBot.archivedAt) || !botPanelConnected}
        />

        {activeBot.archivedAt ? (
          <div className="grok-card-group composer-archived-banner">
            <span className="composer-archived-banner-text">
              {t(`该 Bot 已归档（14 天保留期剩余 ${formatArchivedRemainingDays(activeBot.archivedAt)} 天），当前为只读历史`, `Archived (${formatArchivedRemainingDays(activeBot.archivedAt)}d left of 14d retention) · Read-only history`)}
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
        ) : isRemoteComposer && activeBot.remoteIdentity && remoteApi ? (
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
            floatingDockContainer={remoteFloatingDockEl}
          />
        ) : (
          <>
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

            {/* C6: 用户主动操作引起的条带保留在文档流内并包一层 SmoothExpand 做平滑高度过渡 */}
            <SmoothExpand open={Boolean(activeEditing)}>
              <ComposerEditBanner
                disabled={editSubmitting || !activeEditing}
                onCancel={onCancelEditTurn}
                tr={t}
              />
            </SmoothExpand>

            <SmoothExpand open={effectiveLocalAttachments.length > 0}>
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
            </SmoothExpand>

            <SmoothExpand open={isLocalVoiceActive}>
              {isLocalVoiceActive ? (
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
            </SmoothExpand>

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
                    !activeChatScope
                      ? t('正在读取目标身份…', 'Loading target identity…')
                      : activeEditing
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
                      if (!activeChatScope) return;
                      if (activeEditing) onSubmitEditedTurn();
                      else if (!isPreLlmChat && !isStoppingChat) onSendMessage(canSteerLocal ? 'steer' : 'followUp');
                      return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey && !isCoarsePointer()) {
                      e.preventDefault();
                      if (!activeChatScope) return;
                      if (activeEditing) onSubmitEditedTurn();
                      else if (!isPreLlmChat && !isStoppingChat) onSendMessage('followUp');
                    }
                  }}
                />

                {!activeEditing && (isVoiceActive || (!hasLocalDraft && !showLocalComposerStop && !isStoppingChat)) && (
                  activeBot.hostKind === 'local' ? (
                    <button
                      type="button"
                      className={`grok-composer-mic-inline${isVoiceActive ? ' recording' : ''}`}
                      aria-label={isVoiceActive ? t('完成语音', 'Finish voice') : t('语音输入', 'Voice input')}
                      disabled={!isVoiceActive && (!activeChatScope || isPreLlmChat || isStoppingChat)}
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
                      {!isVoiceActive && !(isPreLlmChat || sendingReceipt || editSubmitting) && hasLocalDraft ? (
                        <>
                          {!activeEditing && canSteerLocal ? (
                            <button
                              type="button"
                              className="grok-composer-steer-btn"
                              aria-label={t('打断并立即发送', 'Interrupt & send immediately')}
                              title={t('打断并立即发送 (Ctrl+Enter)', 'Interrupt & send immediately (Ctrl+Enter)')}
                              disabled={!activeChatScope || sendingReceipt || action.busy || Boolean(slashBusy) || imageUploading || isDeletingActiveBot}
                              onClick={() => onSendMessage('steer')}
                            >
                              <Zap size={16} />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="grok-composer-action-pill send"
                            aria-label={activeEditing ? t('保存并重发', 'Save & resend') : isLlmRunningChat ? t('排队发送', 'Queue message') : t('发送', 'Send')}
                            disabled={!activeChatScope || sendingReceipt || editSubmitting || action.busy || Boolean(slashBusy) || imageUploading || isDeletingActiveBot}
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
