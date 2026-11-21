import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Copy,
  LayoutDashboard,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Quote,
  RotateCcw,
  Settings,
  Trash2,
  User,
  Users,
} from 'lucide-react';
import {
  BotHost,
  type AbortBotResult,
  type BotSoul,
  type HostBot,
  type HostFrameEvent,
  type HostHistoryPage,
  type HostSnapshot,
  type HostSubmission,
  type HostVoiceEvent,
  type TurnDeliveryMode,
  type WithdrawQueuedResult,
  type WithdrawnTurnItem,
} from './native';
import { mobileClientRequest, mobileHaptic, mobileLocalRequest, onMobileStreamFailure } from './native/tauri-host';
import { ActiveCenter, useCenterConnection } from './native/CenterGate';
import { mergeRecalledByTarget } from '../../desktop/web/src/drafts';
import { targetApi } from '../../desktop/web/src/targetApi';
import type { RoomApiResolver } from '../../desktop/web/src/scope-api';
import {
  ConversationContextMenu,
  conversationTitle,
  useScopeConversations,
  type ScopeConversation,
  type ScopeConversationSource,
} from './gbot-ui';
import { useChatPins } from './gbot-ui/chatPins';
import { useConversationUnread } from './gbot-ui/useConversationUnread';
import type { MessageMember } from '../../host-core/index.js';
import { createLocalScopeReadApi } from './local-scope-api';
import './bot-communications-mobile.css';
import type { DesktopIdentity, DesktopPanelApi } from '../../desktop/web/src/types';
import type { DesktopUiProfile, CenterModelPicker } from '../../host-core/desktop-client.js';
import type {
  BotBoardSnapshot,
  BotLiveState,
  ClearHistoryResult,
  CompactResult,
  DevicesDirectoryItem,
  ImageAttachment,
  RemoteControlMethodMap,
  ScopeInfo,
  ShowerTarget,
} from '../../host-core/index.js';
import type { ShowerCall } from './ShowerPreview';
import { BotScreenPanel } from './BotScreenPanel';
import BotBrowserPanel from './bot-browser/BotBrowserPanel';
import { GoogleSetupWizard } from './google/GoogleSetupWizard';
import { selectCurrentGoogleSetup } from './google/currentGoogleSetup';
import { openExternalUrl } from './center-admin/openExternalUrl';
import type {
  BotBrowserControlCall,
  GoogleChatCardContext,
  GoogleSetupControlCall,
  GoogleSetupControlState,
} from './google/types';
import { BotBoard } from './BotBoard';
import { botBoardKey, useBotBoard, useMarkViewedBoardResult, type BotBoardTarget } from './useBotBoard';
import { CapabilitiesPage } from './bot-settings/CapabilitiesPage';
import { formatBotModelSummary, type BotModelDisplayInput } from './bot-settings/modelDisplay';
import { createBrokerCenterTransport } from './center-admin';
import { VaultPanel, type VaultCall } from './vault/VaultPanel';
import type { SkillReviewCall } from './learning/SkillReviewPanel';
import {
  GROK_AVATAR_PRESETS,
  JARVIS_AVATAR_PRESET,
  resolveBotAvatarPreset,
  saveBotAvatarConfig,
  type GrokAvatarPreset,
} from './GrokBotAvatar';
import { botAvatarKey, saveCentralBotAvatar, syncBotAvatarConfigs } from './botAvatarSync';
import {
  canSteerBotActivity,
  canStopBotActivity,
  isBotActivityBusy,
  isBotPreLlmPhase,
  resolveBotActivity,
  resolveComposerActionKind,
  shouldShowComposerStop,
  type BotActivity,
} from './botActivity';
import {
  chatTurnsWithoutToolOutput,
  latestEntryChannel,
  matchesScopedLiveBinding,
  mergeHistoryWaitProjection,
  parseHistoryEntries,
  visibleAssistantTextEntryIds,
  resolveActiveTurnStartedAt,
  type ScopedLiveBinding,
  type ScopedLiveState,
} from './chatTurnModel';
import {
  dedupeAttachmentMetas,
  extractEditableUserText,
  mergeQueuedStripItems,
  mergeWithdrawnIntoDraft,
  resolveAttachmentMetasByIds,
  stripTrailingHostAttachmentLines,
  type UnifiedQueuedStripItem,
} from './composerFlowControl';
import type { QuestionnaireSubmitPayload, VaultUnlockSubmitPayload } from './ToolPresentation';
import {
  IMAGE_MAX_COUNT,
  IMAGE_MAX_TOTAL_BYTES,
  ImagePickError,
  attachmentFileName,
  attachmentIdOf,
  normalizeImageFile,
  pickImagesFromInput,
  type AttachmentFetcher,
  type ImageAttachmentData,
  type PickedImageSource,
} from './imageAttachments';
import { ErrorNotice, array, errorText, record, useAction, useCollapseToolOutput, useHideToolOutput, useText } from './ui';
import { deleteBotAndVerify, formatActionableDirectoryError, isDefiniteSendFailure, isRemoteBotOnline } from './botOperations';
import {
  useGlobalTasks,
  TaskBoardView,
  isTaskWaitingForBot,
  resolveBotChatTaskContext,
  type GlobalTask,
  type TaskBotOption,
  type TaskTransportFn,
} from './tasks';
import {
  uuid,
  DEFAULT_PRIMARY_ROLE,
  CREATE_ATTEMPT_KEY,
  SOUL_MAX_BYTES,
  GroupCreateAttempt,
  RoomDeleteAttempt,
  RoomDeleteModalState,
  BotConfirmModalState,
  UnifiedBotItem,
  BotPreviewMeta,
  BotScheduleTask,
  BotScheduleState,
  BotScheduleDraft,
  TurnAdmissionCarrier,
  chatStorageKey,
  readChatPending,
  readChatDraft,
  writeChatDraft,
  readChatDraftAttachments,
  writeChatDraftAttachments,
  readBotMetaMap,
  writeBotMetaMap,
  readClearedMap,
  writeClearedMap,
  readHasRemoteFlag,
  writeHasRemoteFlag,
  CachedRemoteBot,
  LocalBotsScope,
  LocalBotsFlight,
  readCachedRemoteBots,
  writeCachedRemoteBots,
  readCachedRemoteDevices,
  writeCachedRemoteDevices,
  BotHistoryReadResult,
  isStaleLiveState,
  maxResetEntryId,
  filterHistoryAfterCutoff,
  classifyClearError,
  makeClearError,
  fetchBotHistoryPages,
  sharedHistoryRead,
  maxHistoryEntryId,
  SlashCommandName,
  parseSlashCommand,
  useSlashAutocomplete,
  soulBytes,
  parseBotSoul,
} from './hub/shared';
import { SettingsSheet } from './bot-settings/primitives';
import { MobileClientUpdatePrompt } from './ClientUpdateSection';
import './hub/schedules.css';
import { ActionSheet, Button, ConfirmDialog, Dialog, type ActionSheetItem } from './components/ui';
import { parseHashToRootEntry, useScreenStack, type RootScreen } from './hub/useScreenStack';
import { decideChatAutoScroll, isNearChatBottom } from './hub/chatScrollLogic';
import {
  useIsCoarsePointer,
  type ActiveEditingTurn,
  type BubbleActionTurnState,
  type CenterAdminTab,
  type ChatPending,
  type ChatPendingEntry,
  type CreateBotAttempt,
  type HubSettingsPage,
  type MobileBotItem,
  type MobileHubScreen,
  type PendingTaskChatAction,
  type PendingTaskChatActionInput,
} from './screens/types';
import { MobileModelSettingsHost } from './screens/MobileModelSettingsHost';
import { HubSettingsView, SettingsCenterAdminScreen } from './screens/SettingsScreen';
import { HubScreen } from './screens/HubScreen';
import { CreateBotScreen, CreateGroupScreen } from './screens/CreateScreens';
import {
  BotAvatarScreen,
  BotProfileManageScreen,
  BotProfileScreen,
  BotSchedulesScreen,
  BotSoulScreen,
} from './screens/BotProfileScreens';
import {
  ArchivedBotsScreen,
  BotSkillsScreen,
  ScopesSubpageScreen,
} from './screens/LibraryScreens';
import { ChatScreen } from './screens/ChatScreen';

function buildScopedLiveBinding(
  bot: UnifiedBotItem | null | undefined,
  scopeKey: string,
  localDeviceId: string,
  connectionEpoch: number,
): ScopedLiveBinding | null {
  if (!bot?.primaryConversationId) return null;
  const resolvedLocalDeviceId = localDeviceId || bot.deviceId || '';
  const transportKey = bot.hostKind === 'local'
    ? `local:${connectionEpoch}:${resolvedLocalDeviceId}`
    : `remote:${bot.remoteIdentity?.profileId ?? ''}:${bot.remoteIdentity?.generation ?? ''}:${bot.remoteIdentity?.kind ?? ''}`;
  return {
    scopeKey,
    botKey: bot.key,
    conversationId: bot.primaryConversationId,
    transportKey,
  };
}

export interface HostPageProps {
  onBack?(): void;
  persistentPending?: boolean;
  connectionEpoch?: number;
  active?: boolean;
  /** Optional remote client factory injected by Tauri mobile shell. */
  getOrCreateRemoteClient?(): { api: DesktopPanelApi; invalidate(): void; dispose(): void };
  /** Check/recover the existing connection before a user-requested directory refresh. */
  onRefreshConnection?(): Promise<void>;
  /** Optional callback to open Android system settings. */
  onOpenSystemSettings?(): void;
}

export function HostPage({
  connectionEpoch = 0,
  active = true,
  getOrCreateRemoteClient,
  onRefreshConnection,
  onOpenSystemSettings,
}: HostPageProps = {}) {
  const t = useText();
  const [hideToolOutput] = useHideToolOutput();
  const [collapseToolOutput] = useCollapseToolOutput();
  const action = useAction();
  const activeCenter = useContext(ActiveCenter);
  const centerConn = useCenterConnection();
  const centerConnectionRef = useRef(centerConn);
  centerConnectionRef.current = centerConn;

  // Unified full screen-stack navigation (4 root screens: hub / tasks / board / settings)
  const nav = useScreenStack<MobileHubScreen>(
    typeof window !== 'undefined' ? parseHashToRootEntry(window.location.hash) : { screen: 'hub' },
    { syncHash: active },
  );
  const screen = nav.current.screen;
  const settingsPage: HubSettingsPage =
    nav.current.screen === 'settings' ? (nav.current.settingsPage ?? 'overview') : 'overview';
  const [centerAdminTab, setCenterAdminTab] = useState<CenterAdminTab>('providers');
  const coarsePointer = useIsCoarsePointer();
  const [primaryBackNotice, setPrimaryBackNotice] = useState<{ text: string; seq: number } | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [taskInitialEditMode, setTaskInitialEditMode] = useState(false);
  const [jumpedTaskQuote, setJumpedTaskQuote] = useState<{
    deviceId: string;
    botId: string;
    taskId: string;
    stepId: string | null;
  } | null>(null);
  const [waitingTaskOffsetByBot, setWaitingTaskOffsetByBot] = useState<Record<string, number>>({});
  const [taskReturnId, setTaskReturnId] = useState<string | null>(null);
  const [taskBannerBusy, setTaskBannerBusy] = useState(false);
  const [taskBoardNotice, setTaskBoardNotice] = useState('');
  const [fetchedTasksById, setFetchedTasksById] = useState<Record<string, GlobalTask>>({});
  const taskFetchAttemptedRef = useRef<Set<string>>(new Set());
  const [taskActionFailures, setTaskActionFailures] = useState<Record<string, PendingTaskChatAction>>({});
  const [retryingTaskActionKey, setRetryingTaskActionKey] = useState<string | null>(null);

  // Mobile navigation drawer shares the app's modal focus and dismissal behavior.
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const navigationTriggerRef = useRef<HTMLButtonElement>(null);

  // Hub search
  const [searchQuery, setSearchQuery] = useState('');

  // Hub 群聊 / Bot 长按·右键·键盘上下文菜单与目标。
  const [hubContextMenu, setHubContextMenu] = useState<{
    x: number;
    y: number;
    bot?: UnifiedBotItem;
    room?: ScopeConversation;
  } | null>(null);
  // 群聊/私聊子页：目标 conversation；roomSettingsOpen 控制群详情设置面板。
  const [scopeConversationTarget, setScopeConversationTarget] = useState<ScopeConversation | null>(null);
  const [roomSettingsOpen, setRoomSettingsOpen] = useState(false);
  const [dmTarget, setDmTarget] = useState<{ bot: UnifiedBotItem } | null>(null);
  const [dmSelectedScopeId, setDmSelectedScopeId] = useState<string | null>(null);

  // 确认弹窗状态（不使用全局 window.confirm，适配 Android WebView）
  const [botConfirmModal, setBotConfirmModal] = useState<BotConfirmModalState | null>(null);
  const [roomDeleteModal, setRoomDeleteModal] = useState<RoomDeleteModalState | null>(null);
  const unconfirmedRoomDeletesRef = useRef(new Map<string, RoomDeleteAttempt>());

  // Local Host state (managed transparently in background)
  const [localHost, setLocalHost] = useState<HostSnapshot>();
  // 最新 localHost 的 ref：让 hostRunning/phase 读取始终拿到当前值，不依赖 useMemo 闭包快照。
  const localHostRef = useRef<HostSnapshot | undefined>(localHost);
  localHostRef.current = localHost;
  const [localBots, setLocalBots] = useState<HostBot[]>(() => {
    try {
      const raw = localStorage.getItem('e-launcher:cached-local-bots-v1');
      return raw ? array<HostBot>(JSON.parse(raw)) : [];
    } catch {
      return [];
    }
  });
  const [localBotsLoaded, setLocalBotsLoaded] = useState(false);
  const localBotsFlight = useRef<LocalBotsFlight | null>(null);
  const localBotsPending = useRef<LocalBotsScope | null>(null);
  const localBotsScopeRef = useRef<LocalBotsScope>({ key: '', center: '' });
  const localBotsMounted = useRef(true);
  const startingLocalRef = useRef<Promise<HostSnapshot | undefined> | null>(null);

  // Remote Host state
  const [hasRemoteConfigured, setHasRemoteConfigured] = useState<boolean>(() => readHasRemoteFlag());
  const [remoteProfiles, setRemoteProfiles] = useState<DesktopUiProfile[]>([]);
  const [remoteIdentity, setRemoteIdentity] = useState<DesktopIdentity | null>(null);
  const [remoteConnected, setRemoteConnected] = useState(false);
  const [remoteBots, setRemoteBots] = useState<CachedRemoteBot[]>(() => readCachedRemoteBots());
  const [directoryError, setDirectoryError] = useState('');
  const directoryFlight = useRef(false);
  const directoryGeneration = useRef(0);
  const chatLoadGeneration = useRef(0);
  const profileLoadGeneration = useRef(0);
  const scheduleLoadGeneration = useRef(0);
  const [createAttempt, setCreateAttemptState] = useState<CreateBotAttempt | null>(() => {
    try { return JSON.parse(localStorage.getItem(CREATE_ATTEMPT_KEY) || 'null'); } catch { return null; }
  });
  const setCreateAttempt = (attempt: CreateBotAttempt | null) => {
    if (attempt) localStorage.setItem(CREATE_ATTEMPT_KEY, JSON.stringify(attempt));
    else localStorage.removeItem(CREATE_ATTEMPT_KEY);
    setCreateAttemptState(attempt);
  };
  const [remoteDirectory, setRemoteDirectory] = useState<{
    devices: DevicesDirectoryItem[];
    identity: DesktopIdentity | null;
    failedGeneration: number | null;
  }>(() => ({ devices: readCachedRemoteDevices(), identity: null, failedGeneration: null }));
  const remoteDevices = remoteDirectory.devices;
  const directoryReadFailed = remoteIdentity !== null && remoteDirectory.failedGeneration === remoteIdentity.generation;
  const remoteClientRef = useRef<{ api: DesktopPanelApi; invalidate(): void; dispose(): void } | null>(null);
  // Bot 通信页：本机只读适配器按（设备ID+代际）重建，换设备/重进页面即换 sessionKey。
  // hostRunning 从 localHostRef 读最新相位（不闭包捕获旧快照）；deviceId 变才重建适配器。
  const localScopeApiGen = useRef(0);
  const localScopeApi = useMemo(() => {
    const deviceId = localHost?.deviceId;
    if (!deviceId) return null;
    return createLocalScopeReadApi({
      deviceId,
      generation: ++localScopeApiGen.current,
      hostRunning: () => localHostRef.current?.phase === 'running',
      reportError: () => {},
    });
  }, [localHost?.deviceId]);
  // 适配器替换/卸载时 dispose：置失效旗标、移除共享原生 listener 并取消在途观察，不泄漏。
  useEffect(() => {
    return () => { void localScopeApi?.dispose().catch(() => {}); };
  }, [localScopeApi]);

  // Bot preview metadata & clear cutoff map
  const [botMetaMap, setBotMetaMap] = useState<Record<string, BotPreviewMeta>>(() => readBotMetaMap());
  const [clearedMap, setClearedMap] = useState<Record<string, number>>(() => readClearedMap());
  const clearedMapRef = useRef(clearedMap);
  clearedMapRef.current = clearedMap;
  const [avatarVersion, setAvatarVersion] = useState(0);

  // Active Bot & Chat state
  const [activeBotKey, setActiveBotKey] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<Array<Record<string, unknown>>>([]);
  const chatHistoryRef = useRef(chatHistory);
  chatHistoryRef.current = chatHistory;
  const chatHistoryCacheRef = useRef(new Map<string, Array<Record<string, unknown>>>());
  useEffect(() => {
    const scope = currentChatScope.current;
    if (!scope) return;
    if (chatHistory.length > 0) {
      chatHistoryCacheRef.current.set(scope, chatHistory);
    } else {
      chatHistoryCacheRef.current.delete(scope);
    }
  }, [chatHistory]);
  // 同 scope+同代际并发全量历史读取的 flight 去重；代际失效后旧读不共享、结果丢弃。
  const chatHistoryFlights = useRef(new Map<string, { epoch: number; task: Promise<BotHistoryReadResult | null> }>());
  // 历史读取代际：目标切换、/clear、连接代际变化都递增，旧代 flight 立即不被复用。
  const chatHistoryEpoch = useRef(0);
  // 正在全量读取历史的 scope 标识：每代换新对象（A→B→A 也是新标记），按身份清除不跨代误清。
  const chatLoadingScope = useRef<{ key: string } | null>(null);
  // scopedChatLive 保存绑定到精确 scope/bot/conversation/transport 的实时会话状态（BotLiveState），
  // snapshot 全量替换、update 仅在绑定完全一致时合并 changes，end/切换/重绑清空，防止 durableWaits 等状态跨边界泄漏。
  const [scopedChatLive, setScopedChatLive] = useState<ScopedLiveState<BotLiveState> | undefined>();
  const connectionEpochRef = useRef(connectionEpoch);
  connectionEpochRef.current = connectionEpoch;
  const chatLiveForBot = (bot: UnifiedBotItem | null | undefined, scopeKey: string): BotLiveState | undefined => {
    const binding = buildScopedLiveBinding(bot, scopeKey, localHost?.deviceId || '', connectionEpoch);
    return matchesScopedLiveBinding(scopedChatLive, binding) ? scopedChatLive?.state : undefined;
  };
  const [chatReceipt, setChatReceipt] = useState<HostSubmission>();
  const [chatPending, setChatPending] = useState<ChatPending>();
  const pendingByBot = useRef(new Map<string, ChatPendingEntry>());
  const currentChatScope = useRef('');
  const selectedChatTarget = useRef<{ hostKind: 'local' | 'remote'; hostId: string; botId: string } | undefined>(undefined);
  const localInFlight = useRef(new Set<string>());
  const deletingBots = useRef(new Set<string>());
  const [chatObservationError, setChatObservationError] = useState('');
  // 历史读取失败单独记录：观察恢复成功只清连接问题，不清掉这次历史错误，交给现有 2s 重试。
  const [chatHistoryError, setChatHistoryError] = useState('');
  // 首屏全量历史在途标记：仅 scope 无已加载历史且加载未结束时为真，用于空态的加载提示。
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const chatLoadError = chatObservationError || chatHistoryError;
  const [chatResumeEpoch, setChatResumeEpoch] = useState(0);
  const chatSubmissionRef = useRef<{ botKey: string; requestId: string; afterEntryId: number } | undefined>(undefined);
  const [chatDraft, setChatDraft] = useState('');
  /** 本机 composer 已上传附件引用（仅元数据）；未选择时为空。 */
  const [chatDraftAttachments, setChatDraftAttachments] = useState<ImageAttachment[]>([]);
  /** 上传中/选图失败的可见错误；不走 localStorage。 */
  const [composerImageError, setComposerImageError] = useState('');
  /** 本机图片上传在途：禁重复选择与发送（state 驱动 UI disabled；归属冻结到发起时 scope/bot）。 */
  const [imageUploading, setImageUploading] = useState(false);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [chatTopMenuOpen, setChatTopMenuOpen] = useState(false);
  const [hubAddMenuOpen, setHubAddMenuOpen] = useState(false);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupMembers, setGroupMembers] = useState<MessageMember[]>([]);
  const [groupSearchQuery, setGroupSearchQuery] = useState('');
  const [groupCreating, setGroupCreating] = useState(false);
  const [groupCreateError, setGroupCreateError] = useState('');
  const [groupCreateAttempt, setGroupCreateAttempt] = useState<GroupCreateAttempt | null>(null);
  const groupCreateFlight = useRef(false);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [clearNotice, setClearNotice] = useState('');
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [offlineNotice, setOfflineNotice] = useState<{ botKey: string; text: string }>();
  const [voiceCapturing, setVoiceCapturing] = useState<{ botId: string; requestId: string }>();
  const voiceCapturingRef = useRef<{ botId: string; requestId: string } | undefined>(undefined);
  const updateVoiceCapturing = useCallback(
    (next: { botId: string; requestId: string } | undefined) => {
      voiceCapturingRef.current = next;
      setVoiceCapturing(next);
    },
    [],
  );
  const [voicePartialText, setVoicePartialText] = useState('');
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [editingTurn, setEditingTurn] = useState<ActiveEditingTurn | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [bubbleActionTurn, setBubbleActionTurn] = useState<BubbleActionTurnState | null>(null);
  const [pendingRemoteQuote, setPendingRemoteQuote] = useState<{ seq: number; text: string } | null>(null);
  const [queueActionBusy, setQueueActionBusy] = useState(false);

  useEffect(() => {
    setOfflineNotice(undefined);
    const dismiss = () => setOfflineNotice(undefined);
    document.addEventListener('visibilitychange', dismiss);
    return () => document.removeEventListener('visibilitychange', dismiss);
  }, [screen, activeBotKey, active]);

  useEffect(() => {
    if (!offlineNotice) return;
    const timer = window.setTimeout(() => setOfflineNotice(undefined), 3000);
    return () => window.clearTimeout(timer);
  }, [offlineNotice]);

  useEffect(() => {
    if (!primaryBackNotice) return;
    const timer = window.setTimeout(() => setPrimaryBackNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [primaryBackNotice]);


  // Bot Edit / Create mode state (15847.jpg)
  const [editMode, setEditMode] = useState<'create' | 'edit'>('edit');
  const [editMakePrimary, setEditMakePrimary] = useState(false);
  const [editName, setEditName] = useState('');
  const [editSubtitle, setEditSubtitle] = useState('');
  const [editCwd, setEditCwd] = useState('');
  const [editCwdBaseline, setEditCwdBaseline] = useState('');
  const [editCwdRevision, setEditCwdRevision] = useState<number | null>(null);
  const [editCwdError, setEditCwdError] = useState('');
  const [editSaveErrors, setEditSaveErrors] = useState<Partial<Record<'profile' | 'cwd', string>>>({});
  const [editCwdSaved, setEditCwdSaved] = useState(false);
  const editSaveInFlight = useRef(false);
  const profileEditKeyRef = useRef<{ key: string | null; inFamily: boolean }>({ key: null, inFamily: false });
  const profileManageTrigger = useRef<HTMLButtonElement>(null);
  const restoreProfileManageFocus = useRef(false);
  // 单调递增 token：编辑目标/连接变化丢弃迟到的 cwd 回填结果。
  const editCwdFetchRef = useRef(0);
  // 用户已编辑目录后，异步回填不得覆盖输入。
  const editCwdDirtyRef = useRef(false);
  const [editTargetHost, setEditTargetHost] = useState('local');
  const [editAvatarPreset, setEditAvatarPreset] = useState<GrokAvatarPreset>(GROK_AVATAR_PRESETS[0]);
  const [editInitialSoul, setEditInitialSoul] = useState('');
  const [editVoiceTone, setEditVoiceTone] = useState('未设置'); // i18n-ok
  const [editVoiceSpeed, setEditVoiceSpeed] = useState('1x');
  const [editVoiceLang, setEditVoiceLang] = useState('自动'); // i18n-ok

  // Avatar Picker state (15848.jpg)
  const [avatarTab, setAvatarTab] = useState<'shape' | 'expression'>('shape');
  const [draftAvatar, setDraftAvatar] = useState<GrokAvatarPreset>(GROK_AVATAR_PRESETS[0]);

  // Bot Soul & Extensions state
  const [botSoul, setBotSoul] = useState<BotSoul | null>(null);
  const [soulDraft, setSoulDraft] = useState('');
  const [soulDirty, setSoulDirty] = useState(false);

  // Per-Bot Scheduled Tasks state
  const [botScheduleState, setBotScheduleState] = useState<BotScheduleState & { botKey?: string }>({
    tasks: [],
    exactAlarmGranted: true,
    schedulingError: '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    now: Date.now(),
  });
  const [scheduleFilter, setScheduleFilter] = useState<'all' | 'enabled' | 'paused'>('all');
  const [scheduleEditing, setScheduleEditing] = useState<'new' | 'edit' | null>(null);
  const [scheduleDeleteTarget, setScheduleDeleteTarget] = useState<BotScheduleTask | null>(null);
  const [scheduleCustomWeekdays, setScheduleCustomWeekdays] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState<BotScheduleDraft>({
    title: '',
    prompt: '',
    repeat: 'daily',
    time: '08:00',
    weekdays: [1, 2, 3, 4, 5],
    monthDay: 1,
    alarmMode: 'alarmClock',
    vibrate: true,
    deleteAfterRun: false,
  });

  const [vaultTargetKey, setVaultTargetKey] = useState<string | null>(null);
  const [modelTarget, setModelTarget] = useState<{ botKey: string; botId: string; center: string; identity: DesktopIdentity; api: DesktopPanelApi; tab: 'model' | 'capabilities' } | null>(null);
  const [editModelRef, setEditModelRef] = useState<string>('');
  const [createModelPicker, setCreateModelPicker] = useState<CenterModelPicker | null>(null);
  const [createModelLoading, setCreateModelLoading] = useState(false);
  const mobileCenterTransport = useMemo(
    () => createBrokerCenterTransport((op, params) => mobileClientRequest(op, params)),
    [],
  );

  const observeIdRef = useRef<string | undefined>(undefined);
  const observeTargetRef = useRef<(ScopedLiveBinding & { observationId: string }) | undefined>(undefined);
  const remoteObserveRef = useRef<{ close(): Promise<void> } | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRestoreRef = useRef<number | null>(null);
  const chatScrollRestorePending = useRef(false);
  const chatStickToBottomRef = useRef(true);
  const chatJumpingToBottomRef = useRef(false);
  const chatJumpTimerRef = useRef<number | null>(null);
  const [chatHasNewContent, setChatHasNewContent] = useState(false);
  const forceChatScrollBottom = useCallback(() => {
    if (chatJumpTimerRef.current !== null) {
      window.clearTimeout(chatJumpTimerRef.current);
      chatJumpTimerRef.current = null;
    }
    chatJumpingToBottomRef.current = false;
    chatStickToBottomRef.current = true;
    setChatHasNewContent(false);
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const jumpToLatestMessages = useCallback(() => {
    const el = chatScrollRef.current;
    chatStickToBottomRef.current = true;
    chatJumpingToBottomRef.current = true;
    setChatHasNewContent(false);
    if (chatJumpTimerRef.current !== null) window.clearTimeout(chatJumpTimerRef.current);
    chatJumpTimerRef.current = window.setTimeout(() => {
      chatJumpingToBottomRef.current = false;
      chatJumpTimerRef.current = null;
    }, 800);
    if (!el) return;
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);
  useEffect(() => () => {
    if (chatJumpTimerRef.current !== null) window.clearTimeout(chatJumpTimerRef.current);
  }, []);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const updateBotMeta = useCallback((botKey: string, patch: Partial<BotPreviewMeta>) => {
    setBotMetaMap(prev => {
      const current = prev[botKey] ?? {
        lastText: '',
        updatedAt: Date.now(),
        unread: false,
        notifyEnabled: true,
      };
      const next = { ...prev, [botKey]: { ...current, ...patch } };
      writeBotMetaMap(next);
      return next;
    });
  }, []);

  // connectionEpoch/activeCenter 变化 → 换新 scope 对象（引用比较，A→B→A 也不复用旧对象）；
  // render 期同步赋值让后续调用立刻读到最新 scope，旧轮 valid() 即刻失效。
  const localBotsScopeKey = connectionEpoch + ':' + activeCenter;
  if (localBotsScopeRef.current.key !== localBotsScopeKey) {
    localBotsScopeRef.current = { key: localBotsScopeKey, center: activeCenter };
  }
  useEffect(() => {
    localBotsMounted.current = true;
    return () => { localBotsMounted.current = false; };
  }, []);

  // Transparently sync local bots（单飞：任意时刻至多一轮在途；scope = connectionEpoch+activeCenter 的
  // 单调对象，变化即作废旧轮——每个 await 后先验身份再请求/写状态，新调用在旧轮结束后接力最新 scope 一轮）。
  const syncLocalBots = useCallback((snap?: HostSnapshot): Promise<HostBot[]> => {
    // 一轮读取：scope 为单调对象引用（A→B→A 亦产生新对象），valid() 失效即不再发请求、不写任何 set*。
    const runRound = async (scope: LocalBotsScope, passedSnap?: HostSnapshot): Promise<HostBot[]> => {
      const valid = () => localBotsMounted.current && localBotsScopeRef.current === scope;
      try {
        // 传入的 snap 只属于发起时的 scope，接力轮不使用。
        const currentSnap = passedSnap ?? (await BotHost.snapshot());
        if (!valid()) return [];
        setLocalHost(currentSnap);
        if (currentSnap.phase !== 'running') {
          setLocalBotsLoaded(false);
          return [];
        }
        if (scope.center) {
          try {
            const status = await BotHost.status();
            if (!valid()) return [];
            if (status.center?.centerUrl && new URL(status.center.centerUrl).origin !== new URL(scope.center).origin) {
              setLocalBots([]);
              setLocalBotsLoaded(false);
              return [];
            }
          } catch {
            // Ignore transient status check errors while center is connecting
          }
        }
        if (!valid()) return [];
        const envelope = await BotHost.call({ method: 'listBots', params: {} });
        if (!valid()) return [];
        const list = array<HostBot>(envelope.result);
        setLocalBots(list);
        try { localStorage.setItem('e-launcher:cached-local-bots-v1', JSON.stringify(list)); } catch { /* ignore */ }
        setLocalBotsLoaded(true);
        return list;
      } catch {
        return [];
      }
    };
    const scope = localBotsScopeRef.current;
    if (!localBotsMounted.current) return Promise.resolve([]);
    const flight = localBotsFlight.current;
    if (flight) {
      // 已有在途轮：同 scope 直接共享；异 scope 预约最新 scope 接力一轮，不叠加网络请求。
      // 传入的 snap 属调用方时刻的 scope，只用于本轮首个 round；接力轮一律重新 snapshot。
      if (flight.scope !== scope) localBotsPending.current = scope;
      return flight.task;
    }
    const task = (async (): Promise<HostBot[]> => {
      let result = await runRound(scope, snap);
      for (;;) {
        const next = localBotsPending.current;
        if (!next || !localBotsMounted.current) break;
        localBotsPending.current = null;
        if (next === localBotsScopeRef.current) {
          localBotsFlight.current!.scope = next;
          result = await runRound(next);
        }
      }
      return result;
    })();
    const flightEntry = { scope, task };
    localBotsFlight.current = flightEntry;
    void task.finally(() => {
      if (localBotsFlight.current === flightEntry) localBotsFlight.current = null;
    });
    return task;
  }, []);

  const ensureLocalHostRunning = useCallback(async (): Promise<HostSnapshot | undefined> => {
    if (startingLocalRef.current) return startingLocalRef.current;
    const task = (async () => {
      try {
        let snap = await BotHost.snapshot();
        setLocalHost(snap);
        if (snap.phase === 'running') {
          if (activeCenter) {
            const status = await BotHost.status();
            if (status.center?.centerUrl && new URL(status.center.centerUrl).origin !== new URL(activeCenter).origin) return undefined;
          }
          await syncLocalBots(snap);
          return snap;
        }
        if (snap.phase !== 'starting') return snap;
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 600));
          snap = await BotHost.snapshot();
          setLocalHost(snap);
          if (snap.phase === 'running') {
            if (activeCenter) {
              const status = await BotHost.status();
              if (status.center?.centerUrl && new URL(status.center.centerUrl).origin !== new URL(activeCenter).origin) return undefined;
            }
            await syncLocalBots(snap);
            return snap;
          }
          if (snap.phase === 'failed') break;
        }
        return snap;
      } catch {
        return undefined;
      } finally {
        startingLocalRef.current = null;
      }
    })();
    startingLocalRef.current = task;
    return task;
  }, [syncLocalBots, activeCenter]);

  // Read-only initial snapshot check on mount (does not auto-spawn Local Host on cold open;
  // cached local bots render immediately and Local Host starts on first bot interaction)
  useEffect(() => {
    if (!active) return;
    // 复用 syncLocalBots 单飞通道：内部自行 snapshot，不与 2s 轮询叠加请求；
    // 作废保护由 scope/mounted 检查在请求通道内完成，effect 无需本地 alive 包装。
    void syncLocalBots().catch(() => {});
  }, [active, connectionEpoch, activeCenter, syncLocalBots]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { if (!document.hidden) void syncLocalBots(); }, 2000);
    return () => { window.clearInterval(timer); };
  }, [active, syncLocalBots]);

  // Adopt the center-connected client as well as explicitly configured remote profiles.
  const remoteUnsubscribe = useRef<(() => void) | null>(null);
  useEffect(() => () => { remoteUnsubscribe.current?.(); }, []);
  const ensureRemoteApi = useCallback(async (): Promise<DesktopPanelApi | null> => {
    if (!getOrCreateRemoteClient) return null;
    if (!remoteClientRef.current) {
      remoteClientRef.current = getOrCreateRemoteClient();
      const api = remoteClientRef.current.api;
      remoteUnsubscribe.current = api.subscribe(() => {
        const profiles = api.snapshot?.state.profiles ?? [];
        setRemoteProfiles(profiles);
        const hasAny = profiles.length > 0;
        setHasRemoteConfigured(hasAny);
        writeHasRemoteFlag(hasAny);
        setRemoteIdentity(api.identity);
        setRemoteConnected(api.transportConnected);
      });
    }
    try {
      const snap = await remoteClientRef.current.api.init();
      setRemoteIdentity(remoteClientRef.current.api.identity);
      setRemoteConnected(remoteClientRef.current.api.transportConnected);
      const profiles = snap.state.profiles ?? [];
      setRemoteProfiles(profiles);
      const hasAny = profiles.length > 0;
      setHasRemoteConfigured(hasAny);
      writeHasRemoteFlag(hasAny);
      return remoteClientRef.current.api;
    } catch {
      return remoteClientRef.current?.api ?? null;
    }
  }, [getOrCreateRemoteClient]);

  useEffect(() => {
    if ((activeCenter || hasRemoteConfigured) && getOrCreateRemoteClient) {
      void ensureRemoteApi();
    }
  }, [activeCenter, hasRemoteConfigured, getOrCreateRemoteClient, ensureRemoteApi]);

  const syncRemoteBots = useCallback(async () => {
    const api = remoteClientRef.current?.api;
    const identity = api?.identity;
    if (!api || !identity || !api.transportConnected || directoryFlight.current) return;
    const generation = directoryGeneration.current;
    directoryFlight.current = true;
    try {
      const directory = await api.broker(identity, 'bot_directory', {}).catch(error => {
        if (generation === directoryGeneration.current && api.identity?.generation === identity.generation) {
          setRemoteDirectory(previous => ({ ...previous, failedGeneration: identity.generation }));
        }
        throw error;
      });
      if (generation !== directoryGeneration.current || api.identity?.generation !== identity.generation) return;
      setRemoteDirectory({ devices: directory.devices, identity, failedGeneration: null });
      writeCachedRemoteDevices(directory.devices);
      await syncBotAvatarConfigs(api, directory.bots, localHostRef.current?.deviceId ?? '');
      if (generation !== directoryGeneration.current || api.identity?.generation !== identity.generation) return;
      setRemoteBots(previous => {
        const failed = new Set(directory.errors.map(error => error.deviceId));
        for (const device of directory.devices) if (!device.online) failed.add(device.deviceId);
        const returnedKeys = new Set(directory.bots.map(b => `${b.deviceId}:${b.botId}`));
        const merged = [
          ...directory.bots,
          ...previous
            .filter(bot => failed.has(bot.deviceId) && !returnedKeys.has(`${bot.deviceId}:${bot.botId}`))
            .map(bot => ({ ...bot, online: false })),
        ];
        writeCachedRemoteBots(merged);
        return merged;
      });
      setDirectoryError(formatActionableDirectoryError(directory.errors, directory.devices));
    } catch (error) {
      if (generation === directoryGeneration.current) setDirectoryError(errorText(error));
    } finally {
      directoryFlight.current = false;
    }
  }, []);

  useEffect(() => {
    directoryGeneration.current += 1;
    if (!active || !remoteConnected || !remoteIdentity) return;
    void syncRemoteBots();
    const timer = window.setInterval(() => { if (!document.hidden) void syncRemoteBots(); }, 2000);
    return () => { window.clearInterval(timer); directoryGeneration.current += 1; };
  }, [active, remoteConnected, remoteIdentity?.profileId, remoteIdentity?.generation, syncRemoteBots]);

  useEffect(() => {
    if (!remoteIdentity?.targetDeviceId) return;
    for (const bot of remoteBots) {
      if (bot.deviceId !== remoteIdentity.targetDeviceId || remoteBots.filter(item => item.botId === bot.botId).length !== 1) continue;
      const oldKey = `remote:${remoteIdentity.profileId}:${bot.botId}`;
      const newKey = `remote:${remoteIdentity.profileId}:${bot.deviceId}:${bot.botId}`;
      if (botMetaMap[oldKey] && !botMetaMap[newKey]) updateBotMeta(newKey, botMetaMap[oldKey]);
    }
  }, [remoteBots, remoteIdentity, botMetaMap, updateBotMeta]);

  // Only the local primary Bot is pinned; all other active Bots share recent-activity ordering.
  const { primaryBot, listBotItems, archivedBots, allBotItems } = useMemo(() => {
    void avatarVersion;
    const remoteLocalByIdentity = new Map<string, CachedRemoteBot>();
    const localByIdentity = new Map(localBots.map(bot => [JSON.stringify([bot.deviceId, bot.botId]), bot] as const));
    for (const bot of remoteBots) {
      if (bot.deviceId !== localHost?.deviceId) continue;
      const key = JSON.stringify([bot.deviceId, bot.botId]);
      remoteLocalByIdentity.set(key, bot);
      if (!localByIdentity.has(key)) localByIdentity.set(key, bot);
    }
    const allLocal: MobileBotItem[] = [...localByIdentity.values()].map(b => {
      const identityKey = JSON.stringify([b.deviceId, b.botId]);
      const remoteMirror = remoteLocalByIdentity.get(identityKey) as (CachedRemoteBot & { resolvedModel?: BotModelDisplayInput['resolvedModel'] }) | undefined;
      const mergedModelRef = remoteMirror && 'modelRef' in remoteMirror ? remoteMirror.modelRef : b.modelRef;
      const mergedResolvedModel = remoteMirror?.resolvedModel ?? (b as HostBot & { resolvedModel?: BotModelDisplayInput['resolvedModel'] }).resolvedModel;
      const key = `local:local:${b.botId}`;
      const matchedDevice = remoteDevices.find(device => device.deviceId === b.deviceId);
      return {
        key,
        deviceId: b.deviceId,
        botId: b.botId,
        primaryConversationId: b.primaryConversationId,
        role: b.role,
        description: (b as HostBot & { description?: string }).description ?? '',
        cwd: b.cwd,
        cwdRevision: b.cwdRevision ?? 0,
        modelRef: mergedModelRef,
        resolvedModel: mergedResolvedModel,
        createdAt: b.createdAt,
        lastActivityAt: b.lastActivityAt || undefined,
        lastPreview: b.lastPreview || '',
        archivedAt: b.archivedAt ?? null,
        hostKind: 'local',
        hostId: 'local',
        hostLabel: matchedDevice?.displayName || t('本机', 'Local'),
        platform: matchedDevice?.platform || 'android',
        online: true,
        isPrimary: Boolean(b.isPrimary),
      };
    });

    const api = remoteClientRef.current?.api;
    const activeProfileId = remoteIdentity?.profileId || remoteProfiles[0]?.id || 'default';
    const remoteByIdentity = new Map(remoteBots
      .filter(bot => bot.deviceId !== localHost?.deviceId && !localByIdentity.has(JSON.stringify([bot.deviceId, bot.botId])))
      .map(bot => [JSON.stringify([bot.deviceId, bot.botId]), bot] as const));
    const allRemote: MobileBotItem[] = [...remoteByIdentity.values()].map(b => {
      const key = `remote:${activeProfileId}:${b.deviceId}:${b.botId}`;
      const matchedDevice = remoteDevices.find(device => device.deviceId === b.deviceId);
      const isOnline = isRemoteBotOnline({ remoteConnected, deviceOnline: matchedDevice?.online, botOnline: b.online });
      const shortHostName = matchedDevice?.displayName || b.deviceName || b.deviceId.slice(0, 10);
      return {
        key,
        deviceId: b.deviceId,
        botId: b.botId,
        primaryConversationId: b.primaryConversationId,
        role: b.role,
        description: b.description ?? '',
        cwd: b.cwd,
        cwdRevision: b.cwdRevision ?? 0,
        modelRef: b.modelRef,
        resolvedModel: (b as CachedRemoteBot & { resolvedModel?: BotModelDisplayInput['resolvedModel'] }).resolvedModel,
        createdAt: b.createdAt,
        lastActivityAt: b.lastActivityAt || undefined,
        lastPreview: b.lastPreview || '',
        archivedAt: b.archivedAt ?? null,
        hostKind: 'remote' as const,
        hostId: b.deviceId,
        hostLabel: shortHostName,
        platform: b.platform || matchedDevice?.platform,
        online: isOnline,
        isPrimary: Boolean(b.isPrimary),
        remoteIdentity: remoteIdentity && api ? api.identityForTarget(b.deviceId) : undefined,
      };
    });

    const getSortTime = (item: MobileBotItem): number => {
      const serverMs = Date.parse(item.lastActivityAt || item.createdAt) || 0;
      const metaMs = botMetaMap[item.key]?.updatedAt || 0;
      return Math.max(serverMs, metaMs);
    };

    const unarchivedLocal = allLocal.filter(b => !b.archivedAt);
    const unarchivedRemote = allRemote.filter(b => !b.archivedAt);

    const primary =
      unarchivedLocal.find(b => b.isPrimary) ??
      null;

    const regularBots = [
      ...unarchivedLocal.filter(b => b.key !== primary?.key),
      ...unarchivedRemote,
    ].sort((a, b) => getSortTime(b) - getSortTime(a) || a.botId.localeCompare(b.botId));

    const archived = [...allLocal.filter(b => Boolean(b.archivedAt)), ...allRemote.filter(b => Boolean(b.archivedAt))]
      .sort((a, b) => (Date.parse(b.archivedAt || '') || 0) - (Date.parse(a.archivedAt || '') || 0));

    const allItems = [...(primary ? [primary] : []), ...regularBots, ...archived];
    return { primaryBot: primary, listBotItems: regularBots, archivedBots: archived, allBotItems: allItems };
  }, [localBots, remoteBots, remoteDevices, remoteProfiles, remoteConnected, remoteIdentity, localHost?.deviceId, botMetaMap, avatarVersion, t]);

  const activeBot = useMemo<MobileBotItem | null>(() => {
    if (!activeBotKey) return null;
    if (primaryBot && activeBotKey === primaryBot.key) return primaryBot;
    return allBotItems.find(b => b.key === activeBotKey) ?? null;
  }, [activeBotKey, primaryBot, allBotItems]);

  /** 群聊/私聊读取来源：本机走只读适配器，远端按 host 分组固定其真实 identity，不污染全局 identity。
      离线仍保留同账户来源（hook 内部停请求、保留最近快照）；targetApi 只按真实设备在线状态收敛。 */
  // scopeConversationSources 只按「内容签名」重建：allBotItems/remoteDevices 每轮目录
  // 刷新都换引用，数组/Map 依赖会让 detail 不断拿到新 api Proxy；改为内容相同的
  // 字符串签名作依赖（名字/在线/设备集合/代际真实变化才重建），不新增缓存层。
  const knownBotsSig = JSON.stringify(
    allBotItems
      .map(item => [
        item.deviceId,
        item.botId,
        item.role,
        Boolean(item.isPrimary),
        item.hostLabel ?? '',
        item.platform ?? '',
        item.description ?? '',
      ] as const)
      .sort((a, b) => a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1)),
  );
  const remoteScopeHostSig = [...new Set(
    allBotItems.filter(item => item.hostKind === 'remote').map(item => item.hostId),
  )].sort().join('\u0001');
  // 设备签名含在线布尔：同 remoteConnected 下单设备上下线必须重建 targetApi。
  const remoteDeviceNameSig = remoteDevices
    .map(d => d.deviceId + '\u0001' + (d.displayName ?? '') + '\u0001' + Boolean(d.online))
    .join('\u0002');
  // Scopes knownBots prop 与群头像共用：同一内容签名，目录同内容刷新引用稳定；透传自然设备标签/平台/简介。
  const knownBots = useMemo(
    () => allBotItems.map(item => ({
      deviceId: item.deviceId,
      botId: item.botId,
      role: item.role,
      isPrimary: Boolean(item.isPrimary),
      deviceName: item.hostLabel,
      hostLabel: item.hostLabel,
      platform: item.platform,
      description: item.description,
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [knownBotsSig],
  );
  const scopeConversationSources = useMemo<ScopeConversationSource[]>(() => {
    // 内部按当前同内容值构建：sig 相同即语义相同，重建结果是同值数组。
    const remoteHostIds = remoteScopeHostSig ? remoteScopeHostSig.split('\u0001') : [];
    const nameByDevice = new Map(remoteDevices.map(d => [d.deviceId, d.displayName]));
    const sources: ScopeConversationSource[] = [];
    const localIdentity = localScopeApi?.identity;
    if (localScopeApi && localIdentity && localHost?.deviceId) {
      sources.push({
        api: localScopeApi,
        identity: localIdentity,
        bots: knownBots,
        label: t('本机', 'Local'),
      });
    }
    const api = remoteClientRef.current?.api;
    if (api && remoteIdentity) {
      for (const hostId of remoteHostIds) {
        const identity = api.identityForTarget(hostId);
        if (!identity) continue;
        const deviceOnline = Boolean(remoteConnected && remoteDevices.find(d => d.deviceId === hostId)?.online);
        // 冻结 identity 到该 host：list/详情读取不能依赖可变的全局 target；
        // 离线来源仍在（transportConnected=false），保留已缓存列表不静默清空。
        sources.push({
          api: targetApi(api, hostId, deviceOnline),
          identity,
          bots: knownBots,
          label: nameByDevice.get(hostId) || t('未命名设备', 'Unnamed device'),
        });
      }
    }
    return sources;
    // 依赖全是内容签名标量 + 真实身份标量；目录刷新同内容不重建，不同内容才重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localScopeApi, localHost?.deviceId, knownBotsSig, remoteScopeHostSig, remoteDeviceNameSig,
      remoteIdentity?.generation, remoteIdentity?.profileId, remoteIdentity?.kind, remoteConnected, t]);

  /**
   * 群聊写端：复用中心/中继连接的完整 DesktopPanelApi（同一份 pending/草稿账本），
   * 不新造本机写适配器。members 固定打 scope.authorityDeviceId（只有 authority 可
   * updateScope，null 不伪造目标）；send 打当前成员所在 Host —— 本机成员优先本机，
   * 其次在线 authority 成员、其他在线成员，全离线保留稳定成员目标供排队。
   * local profile 的 identityForTarget 不能跨设备（api.ts 会抛），远端目标只在 relay 时取。
   */
  const roomWriteTargetApiMap = useMemo(() => {
    const api = remoteClientRef.current?.api;
    if (!api || !remoteIdentity) return new Map<string, DesktopPanelApi>();
    const localId = localHost?.deviceId;
    const running = localHost?.phase === 'running';
    const candidates = new Set<string>(remoteDevices.map(d => d.deviceId));
    if (localId) candidates.add(localId);
    const map = new Map<string, DesktopPanelApi>();
    for (const deviceId of candidates) {
      const online = deviceId === localId
        ? running
        : Boolean(remoteConnected && remoteDevices.some(d => d.deviceId === deviceId && d.online));
      // local profile 的 identityForTarget 只能绑当前 targetDeviceId：跨设备候选没有
      // 写端，跳过而非回环本机（远端 authority 不得别名为本机）。targetApi 内部调用
      // identityForTarget，异常时跳过该设备即可。
      if (remoteIdentity.kind === 'local' && deviceId !== remoteIdentity.targetDeviceId) continue;
      try {
        map.set(deviceId, targetApi(api, deviceId, online));
      } catch {
        continue;
      }
    }
    return map;
    // 依赖为内容签名/标量：目录同内容刷新不重建 Proxy，在线布尔真实变化才重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteIdentity?.profileId, remoteIdentity?.kind, remoteIdentity?.targetDeviceId,
      remoteIdentity?.generation, remoteConnected, remoteDeviceNameSig, localHost?.deviceId, localHost?.phase]);

  const roomSendDeviceIdOf = useCallback((scope: ScopeInfo): string => {
    const memberDevices = scope.scope.members.map(m => m.deviceId);
    const localId = localHost?.deviceId;
    if (localId && localHost?.phase === 'running' && memberDevices.includes(localId)) return localId;
    const authority = scope.authorityDeviceId;
    if (authority && memberDevices.includes(authority) && remoteDevices.some(d => d.deviceId === authority && d.online)) {
      return authority;
    }
    const onlineMember = memberDevices.find(id => remoteDevices.some(d => d.deviceId === id && d.online));
    if (onlineMember) return onlineMember;
    if (authority && memberDevices.includes(authority)) return authority;
    return memberDevices[0] ?? '';
    // 在线布尔已含在 remoteDeviceNameSig；目录同内容刷新不换 resolver 引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localHost?.deviceId, localHost?.phase, remoteDeviceNameSig]);

  const resolveRoomApi = useCallback<RoomApiResolver>((scope, purpose) => {
    const target = purpose === 'members' ? scope.authorityDeviceId : roomSendDeviceIdOf(scope);
    if (!target) return null;
    return roomWriteTargetApiMap.get(target) ?? null;
  }, [roomSendDeviceIdOf, roomWriteTargetApiMap]);

  // 群成员候选只收未归档 Bot；字段与 ScopeBotInfo 一致（含 hostLabel/platform/description）。
  // 独立签名含归档布尔与展示信息：归档/恢复或设备标签变化必须重建候选，目录同内容刷新引用稳定。
  const memberCandidatesSig = JSON.stringify(
    allBotItems
      .map(item => [
        item.deviceId,
        item.botId,
        item.role,
        Boolean(item.isPrimary),
        Boolean(item.archivedAt),
        item.hostLabel ?? '',
        item.platform ?? '',
        item.description ?? '',
      ] as const)
      .sort((a, b) => a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1)),
  );
  const roomMemberCandidates = useMemo(
    () => allBotItems.filter(item => !item.archivedAt).map(item => ({
      deviceId: item.deviceId,
      botId: item.botId,
      role: item.role,
      isPrimary: Boolean(item.isPrimary),
      deviceName: item.hostLabel,
      hostLabel: item.hostLabel,
      platform: item.platform,
      description: item.description,
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memberCandidatesSig],
  );

  const {
    items: roomConversations,
    loaded: roomConversationsLoaded,
    loading: roomConversationsLoading,
    error: roomConversationsError,
    refresh: refreshRoomConversations,
    markDeleted: markRoomConversationDeleted,
  } = useScopeConversations(scopeConversationSources, active && screen === 'hub', 'room');
  // 下拉刷新用最新 refresh：ref 免除把 hook 返回值塞进 triggerHubRefresh 依赖。
  const refreshRoomConversationsRef = useRef(refreshRoomConversations);
  refreshRoomConversationsRef.current = refreshRoomConversations;
  const markRoomConversationDeletedRef = useRef(markRoomConversationDeleted);
  markRoomConversationDeletedRef.current = markRoomConversationDeleted;

  // 置顶分区：按 activeCenter 或本机稳定账号标识（不含 generation）。
  const pinStorageScope = useMemo(() => {
    const centerRaw = (activeCenter || centerConn.saved?.url || centerConn.url || '').trim();
    if (centerRaw) {
      try {
        return `center:${new URL(centerRaw).origin}`;
      } catch {
        return `center:${centerRaw}`;
      }
    }
    if (remoteIdentity?.profileId) {
      return `profile:${remoteIdentity.profileId}:${remoteIdentity.kind}`;
    }
    const localDev = localHost?.deviceId || localBots[0]?.deviceId || 'local';
    return `local:${localDev}`;
  }, [activeCenter, centerConn.saved?.url, centerConn.url, remoteIdentity?.profileId, remoteIdentity?.kind, localHost?.deviceId, localBots]);

  const boardTargets: BotBoardTarget[] = allBotItems.filter(bot => !bot.archivedAt).map(bot => ({
    key: botBoardKey(pinStorageScope, bot.deviceId, bot.botId),
    hostKey: JSON.stringify([bot.hostKind, bot.deviceId]),
    generation: JSON.stringify([connectionEpoch, remoteIdentity?.generation, localHost?.phase, pinStorageScope]),
    botId: bot.botId,
    name: bot.role,
    deviceName: bot.hostKind === 'local' ? bot.hostLabel : remoteDevices.find(device => device.deviceId === bot.deviceId)?.displayName || t('远程设备', 'Remote device'),
    avatarKey: botAvatarKey(bot),
    isPrimary: bot.isPrimary,
    online: bot.hostKind === 'local' ? localHost?.phase === 'running' : !!bot.online && remoteConnected,
    read: async botIds => {
      if (bot.hostKind === 'local') {
        const envelope = await BotHost.call({ method: 'getBotBoard', params: { botIds } });
        return envelope.result as BotBoardSnapshot;
      }
      if (!bot.remoteIdentity || !remoteClientRef.current) throw new Error('Host unavailable');
      return remoteClientRef.current.api.call(bot.remoteIdentity, 'getBotBoard', { botIds });
    },
  }));
  const activeBoardTarget = activeBot
    ? boardTargets.find(target => target.key === botBoardKey(pinStorageScope, activeBot.deviceId, activeBot.botId))
    : undefined;
  const board = useBotBoard(
    screen === 'board' ? boardTargets : activeBoardTarget ? [activeBoardTarget] : [],
    active && (screen === 'board' || screen === 'chat'),
  );

  // 同一中心可以更换绑定；任务与未读记录同时按中心地址、已确认身份及档案隔离。
  const centerAccountId = centerConn.saved?.deviceId || centerConn.status?.clientId;
  const taskScopeKey = `${pinStorageScope}|${centerAccountId ?? ''}|${remoteIdentity?.profileId ?? ''}|${remoteIdentity?.kind ?? ''}`;
  const taskScopeRef = useRef(taskScopeKey);
  const taskScopeEpochRef = useRef(0);
  if (taskScopeRef.current !== taskScopeKey) {
    taskScopeRef.current = taskScopeKey;
    taskScopeEpochRef.current += 1;
  }

  const localRunning = localHost?.phase === 'running';
  const taskTransport = useMemo<TaskTransportFn | null>(() => {
    const remoteApi = remoteClientRef.current?.api;
    const expectedScope = taskScopeKey;
    const expectedEpoch = taskScopeEpochRef.current;
    const ensureCurrentScope = () => {
      if (taskScopeRef.current !== expectedScope || taskScopeEpochRef.current !== expectedEpoch) {
        throw new Error(t('任务作用域已切换', 'Task scope changed'));
      }
    };
    if (remoteConnected && remoteIdentity && remoteApi) {
      return async (input) => {
        ensureCurrentScope();
        try {
          const res = await (remoteApi.broker as (id: DesktopIdentity, op: string, params: unknown) => Promise<unknown>)(
            remoteIdentity,
            'global_tasks',
            input,
          );
          ensureCurrentScope();
          return res;
        } catch (err) {
          ensureCurrentScope();
          const e = err as { code?: unknown; message?: unknown } | null;
          const msg = typeof e?.message === 'string' ? e.message : String(err ?? '');
          const isUnsupported =
            e?.code === 'INVALID_ARGUMENT' ||
            /unsupported desktop broker operation/i.test(msg);
          if (!isUnsupported) throw err;
          if (localHostRef.current?.phase === 'running') {
            const envelope = await BotHost.call({ method: 'manageTasks', params: input });
            ensureCurrentScope();
            return envelope.result;
          }
          const fallbackDeviceId =
            remoteIdentity.kind === 'local'
              ? remoteIdentity.targetDeviceId
              : (remoteDevices.find((d) => d.online)?.deviceId ?? remoteIdentity.targetDeviceId);
          if (!fallbackDeviceId) throw err;
          const res = await (remoteApi.call as (id: DesktopIdentity, method: string, params: unknown) => Promise<unknown>)(
            remoteApi.identityForTarget(fallbackDeviceId),
            'manageTasks',
            input,
          );
          ensureCurrentScope();
          return res;
        }
      };
    }
    if (localRunning) {
      return async (input) => {
        ensureCurrentScope();
        const envelope = await BotHost.call({ method: 'manageTasks', params: input });
        ensureCurrentScope();
        return envelope.result;
      };
    }
    return null;
  }, [remoteConnected, remoteIdentity, remoteDevices, localRunning, taskScopeKey, t]);

  const globalTasks = useGlobalTasks({
    transport: taskTransport,
    enabled: active && taskTransport !== null,
    scopeKey: taskScopeKey,
    draftStorageKey: `e-launcher:task-create-draft:v1:${pinStorageScope}`,
  });

  const clearedTaskScopeRef = useRef(taskScopeKey);
  useEffect(() => {
    if (clearedTaskScopeRef.current === taskScopeKey) return;
    clearedTaskScopeRef.current = taskScopeKey;
    setActiveTaskId(null);
    setCreatingTask(false);
    setTaskInitialEditMode(false);
    setJumpedTaskQuote(null);
    setWaitingTaskOffsetByBot({});
    setTaskReturnId(null);
    setTaskBannerBusy(false);
    setTaskBoardNotice('');
    setFetchedTasksById({});
    taskFetchAttemptedRef.current.clear();
    setTaskActionFailures({});
    setRetryingTaskActionKey(null);
  }, [taskScopeKey]);

  const wasTasksScreenRef = useRef(screen === 'tasks');
  useEffect(() => {
    const isTasks = screen === 'tasks';
    if (wasTasksScreenRef.current && !isTasks) {
      if (globalTasks.createDraft.trim()) {
        globalTasks.markDraftLeftUnpublished();
      }
      setCreatingTask(false);
      setTaskInitialEditMode(false);
      setTaskBoardNotice('');
    }
    wasTasksScreenRef.current = isTasks;
  }, [screen, globalTasks.createDraft, globalTasks.markDraftLeftUnpublished]);

  const taskBotOptions = useMemo<TaskBotOption[]>(() => {
    return allBotItems
      .filter((b) => !b.archivedAt)
      .map((b) => ({
        deviceId: b.deviceId,
        botId: b.botId,
        name: b.role,
        description: b.description,
        online: b.hostKind === 'local' ? localRunning : Boolean(b.online && remoteConnected),
        avatar: botAvatarKey(b),
        isPrimary: Boolean(b.isPrimary),
      }));
  }, [allBotItems, localRunning, remoteConnected]);

  const effectiveGlobalTasks = useMemo(() => {
    const existingIds = new Set(globalTasks.tasks.map((item) => item.id));
    const extras = Object.values(fetchedTasksById).filter((item) => !existingIds.has(item.id));
    return extras.length ? [...globalTasks.tasks, ...extras] : globalTasks.tasks;
  }, [globalTasks.tasks, fetchedTasksById]);

  const activeBotTopicKey = activeBot ? `${activeBot.deviceId}:${activeBot.botId}` : '';
  const activeBotJumpedTaskId =
    activeBot &&
    jumpedTaskQuote &&
    jumpedTaskQuote.deviceId === activeBot.deviceId &&
    jumpedTaskQuote.botId === activeBot.botId
      ? jumpedTaskQuote.taskId
      : null;
  const activeBotJumpedStepId =
    activeBot &&
    jumpedTaskQuote &&
    jumpedTaskQuote.deviceId === activeBot.deviceId &&
    jumpedTaskQuote.botId === activeBot.botId
      ? jumpedTaskQuote.stepId
      : null;

  useEffect(() => {
    if (!active || !taskTransport) return;
    const candidateIds = [activeBotJumpedTaskId, taskReturnId].filter((id): id is string => Boolean(id));
    for (const tid of candidateIds) {
      if (globalTasks.tasks.some((item) => item.id === tid)) continue;
      if (fetchedTasksById[tid]) continue;
      const attemptKey = `${taskScopeKey}|${tid}`;
      if (taskFetchAttemptedRef.current.has(attemptKey)) continue;
      taskFetchAttemptedRef.current.add(attemptKey);
      const capturedScope = taskScopeKey;
      const capturedEpoch = taskScopeEpochRef.current;
      void globalTasks
        .getTask(tid)
        .then((fetched) => {
          if (taskScopeRef.current !== capturedScope || taskScopeEpochRef.current !== capturedEpoch || !fetched) return;
          setFetchedTasksById((prev) => ({ ...prev, [fetched.id]: fetched }));
        })
        .catch(() => {
          // 列表截断补充查询失败时保留静态回退，不阻塞聊天主流程。
        });
    }
  }, [active, taskTransport, activeBotJumpedTaskId, taskReturnId, globalTasks, fetchedTasksById, taskScopeKey]);

  const activeBotTaskContext = useMemo(
    () =>
      activeBot
        ? resolveBotChatTaskContext({
            tasks: effectiveGlobalTasks,
            botDeviceId: activeBot.deviceId,
            botId: activeBot.botId,
            jumpedTaskId: activeBotJumpedTaskId,
            jumpedStepId: activeBotJumpedStepId,
            waitingOffset: waitingTaskOffsetByBot[activeBotTopicKey] ?? 0,
          })
        : {
            waitingTasks: [],
            waitingIndex: 0,
            linkedTask: null,
            focusedStep: null,
            promptTask: null,
            showQuoteStrip: false,
            taskPrefix: '',
          },
    [
      activeBot,
      effectiveGlobalTasks,
      activeBotJumpedTaskId,
      activeBotJumpedStepId,
      waitingTaskOffsetByBot,
      activeBotTopicKey,
    ],
  );
  const activeBotLinkedTask = activeBotTaskContext.linkedTask;
  const activeBotFocusedStep = activeBotTaskContext.focusedStep;
  const activeBotBannerTask = activeBotTaskContext.linkedTask;
  const activeBotTaskPrefix = activeBotTaskContext.taskPrefix;

  const executeTaskChatAction = useCallback(
    async (spec: PendingTaskChatActionInput): Promise<boolean> => {
      const failureKey = `${spec.scopeKey}|${spec.botKey}`;
      try {
        let updated: GlobalTask;
        if (spec.kind === 'answer_prompt') {
          updated = await globalTasks.answerPrompt(spec.taskId, spec.answer);
        } else if (spec.kind === 'confirm_plan') {
          updated = await globalTasks.confirmPlan(spec.taskId);
        } else {
          updated = await globalTasks.updateTask(spec.payload);
        }
        if (taskScopeRef.current !== spec.scopeKey) return false;
        if (updated) {
          setFetchedTasksById((prev) => ({ ...prev, [updated.id]: updated }));
        }
        setTaskActionFailures((prev) => {
          if (!prev[failureKey]) return prev;
          const next = { ...prev };
          delete next[failureKey];
          return next;
        });
        return true;
      } catch (err) {
        if (taskScopeRef.current !== spec.scopeKey) return false;
        setTaskActionFailures((prev) => ({
          ...prev,
          [failureKey]: { ...spec, error: errorText(err) },
        }));
        return false;
      }
    },
    [globalTasks],
  );

  const retryTaskChatAction = useCallback(
    async (failure: PendingTaskChatAction) => {
      const failureKey = `${failure.scopeKey}|${failure.botKey}`;
      setRetryingTaskActionKey(failureKey);
      try {
        await executeTaskChatAction(failure);
      } finally {
        setRetryingTaskActionKey((cur) => (cur === failureKey ? null : cur));
      }
    },
    [executeTaskChatAction],
  );

  const dismissTaskChatAction = useCallback((failure: PendingTaskChatAction) => {
    const failureKey = `${failure.scopeKey}|${failure.botKey}`;
    setTaskActionFailures((prev) => {
      if (!prev[failureKey]) return prev;
      const next = { ...prev };
      delete next[failureKey];
      return next;
    });
  }, []);

  const handleTaskMessageAccepted = useCallback(
    (
      linkedTaskSnapshot: GlobalTask | null,
      rawText: string,
      botInfo: { deviceId: string; botId: string; role: string },
      capturedScope: string,
    ) => {
      if (!linkedTaskSnapshot || !rawText) return;
      const botKey = `${botInfo.deviceId}:${botInfo.botId}`;
      if (
        linkedTaskSnapshot.pendingPrompt?.kind === 'question' &&
        isTaskWaitingForBot(linkedTaskSnapshot, botInfo.deviceId, botInfo.botId)
      ) {
        void executeTaskChatAction({
          kind: 'answer_prompt',
          scopeKey: capturedScope,
          botKey,
          taskId: linkedTaskSnapshot.id,
          taskTitle: linkedTaskSnapshot.title,
          answer: rawText,
        });
      } else if (
        linkedTaskSnapshot.pendingPrompt?.kind === 'plan' &&
        isTaskWaitingForBot(linkedTaskSnapshot, botInfo.deviceId, botInfo.botId)
      ) {
        void executeTaskChatAction({
          kind: 'update_task',
          scopeKey: capturedScope,
          botKey,
          taskId: linkedTaskSnapshot.id,
          taskTitle: linkedTaskSnapshot.title,
          payload: {
            taskId: linkedTaskSnapshot.id,
            fromChatBotId: botInfo.botId,
            fromChatDeviceId: botInfo.deviceId,
            logText: t(`${botInfo.role} 对话补充：${rawText.slice(0, 120)}`, `${botInfo.role} chat note: ${rawText.slice(0, 120)}`),
          },
        });
      }
    },
    [executeTaskChatAction, t],
  );

  const chatPins = useChatPins(pinStorageScope);
  const botPinKey = useCallback((bot: { deviceId: string; botId: string }) => `bot:${bot.deviceId}:${bot.botId}`, []);
  const roomPinKey = useCallback((scopeId: string) => `room:${scopeId}`, []);
  const unreadNamespace = pinStorageScope.startsWith('center:')
    ? (centerAccountId ? JSON.stringify([pinStorageScope, centerAccountId]) : null)
    : (centerConn.initialized && pinStorageScope !== 'local:local' ? pinStorageScope : null);
  const unreadRows = useMemo(() => [
    ...listBotItems.map(item => ({
      key: botPinKey(item),
      lastMessageAt: item.lastPreview?.trim() ? item.lastActivityAt ?? null : null,
    })),
    ...roomConversations.map(room => ({
      key: roomPinKey(room.scope.scope.scopeId),
      lastMessageAt: room.lastActivityAt,
    })),
  ], [listBotItems, roomConversations, botPinKey, roomPinKey]);
  const { unread: unreadConversationKeys, markViewed: markConversationViewed } = useConversationUnread(
    unreadNamespace,
    unreadRows,
    active && screen === 'chat' && activeBot ? botPinKey(activeBot) : null,
  );
  const markRoomHistoryViewed = useCallback((scopeId: string, lastMessageAt: string) => {
    markConversationViewed(roomPinKey(scopeId), lastMessageAt);
  }, [markConversationViewed, roomPinKey]);

  // 群聊和普通 Bot 混排：key 统一为 bot:${deviceId}:${botId} / room:${scopeId}。
  // 置顶项按 pinnedKeys 顺序排在列表最上（不随消息时间变），普通项按最近时间倒序；
  // 仅顶部 Hero 的本机主 Bot 不参与列表置顶，下方列表中的远端主 Bot 属于普通列表项可置顶/拖动。
  const mixedHubItems = useMemo(() => {
    const entries: {
      key: string;
      pinKey: string;
      pinned: boolean;
      pinIndex: number;
      bot?: UnifiedBotItem;
      room?: ScopeConversation;
      sortMs: number;
    }[] = [];
    for (const item of listBotItems) {
      const meta = botMetaMap[item.key];
      const pKey = botPinKey(item);
      const canPin = !item.archivedAt && item.key !== primaryBot?.key;
      const pIdx = canPin ? chatPins.pinnedKeys.indexOf(pKey) : -1;
      entries.push({
        key: pKey,
        pinKey: pKey,
        pinned: pIdx !== -1,
        pinIndex: pIdx,
        bot: item,
        sortMs: Math.max(Date.parse(item.lastActivityAt || item.createdAt) || 0, meta?.updatedAt || 0),
      });
    }
    for (const room of roomConversations) {
      const pKey = roomPinKey(room.scope.scope.scopeId);
      const pIdx = chatPins.pinnedKeys.indexOf(pKey);
      entries.push({
        key: pKey,
        pinKey: pKey,
        pinned: pIdx !== -1,
        pinIndex: pIdx,
        room,
        sortMs: Date.parse(room.lastActivityAt || '') || 0,
      });
    }
    entries.sort((a, b) => {
      if (a.pinned && b.pinned) return a.pinIndex - b.pinIndex;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.sortMs - a.sortMs || a.key.localeCompare(b.key);
    });
    return entries;
  }, [listBotItems, primaryBot?.key, roomConversations, botMetaMap, botPinKey, roomPinKey, chatPins.pinnedKeys]);

  const filteredMixedHubItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return mixedHubItems;
    return mixedHubItems.filter(entry => {
      if (entry.bot) {
        const item = entry.bot;
        const meta = botMetaMap[item.key];
        return (
          item.role.toLowerCase().includes(q) ||
          item.hostLabel.toLowerCase().includes(q) ||
          (item.lastPreview ?? meta?.lastText ?? '').toLowerCase().includes(q) ||
          (item.description ?? '').toLowerCase().includes(q)
        );
      }
      const room = entry.room!;
      return room.title.toLowerCase().includes(q) || room.lastPreview.toLowerCase().includes(q);
    });
  }, [mixedHubItems, searchQuery, botMetaMap]);

  // 当前可见置顶项 key 列表；重排时将可见顺序合并回完整 pinnedKeys，过滤/搜索不丢隐藏 pins。
  const visiblePinnedKeys = useMemo(
    () => filteredMixedHubItems.filter(e => e.pinned).map(e => e.pinKey),
    [filteredMixedHubItems],
  );
  const handleReorderPinnedKeys = useCallback(
    (nextVisibleKeys: string[]) => {
      const visibleSet = new Set(visiblePinnedKeys);
      let cursor = 0;
      const merged = chatPins.pinnedKeys.map(k => (visibleSet.has(k) ? nextVisibleKeys[cursor++] ?? k : k));
      for (; cursor < nextVisibleKeys.length; cursor++) {
        const k = nextVisibleKeys[cursor];
        if (!merged.includes(k)) merged.push(k);
      }
      chatPins.reorderPins(merged);
    },
    [visiblePinnedKeys, chatPins],
  );

  const openScopeConversation = (item: ScopeConversation, initialSettingsOpen = false) => {
    if (screen === 'chat' && chatScrollRef.current) {
      chatScrollRestoreRef.current = chatScrollRef.current.scrollTop;
    }
    setHubContextMenu(null);
    setHubAddMenuOpen(false);
    setChatTopMenuOpen(false);
    setComposerMenuOpen(false);
    setChatSearchOpen(false);
    setChatSearchQuery('');
    setRoomSettingsOpen(initialSettingsOpen);
    setScopeConversationTarget(item);
    if (screen === 'group-create') {
      nav.replaceTop({ screen: 'conversation' });
    } else {
      nav.push({ screen: 'conversation' });
    }
  };

  const openBotDmList = (bot: UnifiedBotItem) => {
    // 从聊天进入私聊时记录 scrollTop：返回主聊天由 layout effect 恢复并跳过一次自动滚底。
    if (screen === 'chat' && chatScrollRef.current) {
      chatScrollRestoreRef.current = chatScrollRef.current.scrollTop;
    }
    // 进入私聊前收起主聊天临时控件（更多菜单/输入框菜单/搜索），返回时不拦截逐级返回。
    setHubContextMenu(null);
    setChatTopMenuOpen(false);
    setComposerMenuOpen(false);
    setChatSearchOpen(false);
    setChatSearchQuery('');
    setDmTarget({ bot });
    setDmSelectedScopeId(null);
    nav.push({ screen: 'dm', botKey: bot.key });
  };

  // 换账户/档案/代际/本机设备时，已打开的群聊/私聊子页不得残留旧会话内容：清空目标并出栈。
  const scopeSessionKey = `${localHost?.deviceId ?? 'nodev'}|${remoteIdentity?.profileId ?? '-'}|${remoteIdentity?.kind ?? '-'}|${remoteIdentity?.generation ?? 0}`;
  const scopeSessionRef = useRef(scopeSessionKey);
  useEffect(() => {
    if (scopeSessionRef.current === scopeSessionKey) return;
    scopeSessionRef.current = scopeSessionKey;
    setScopeConversationTarget(null);
    setRoomSettingsOpen(false);
    setDmTarget(null);
    setDmSelectedScopeId(null);
    setHubContextMenu(null);
    setHubAddMenuOpen(false);
    setBotConfirmModal(null);
    setScheduleDeleteTarget(null);
    if (screen === 'conversation' || screen === 'dm') {
      if (!nav.pop()) nav.resetTo({ screen: 'hub' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeSessionKey]);

  const scopeAccountKey = `${localHost?.deviceId ?? 'nodev'}|${remoteIdentity?.profileId ?? '-'}|${remoteIdentity?.kind ?? '-'}`;
  const scopeAccountRef = useRef(scopeAccountKey);
  useEffect(() => {
    if (scopeAccountRef.current === scopeAccountKey) return;
    scopeAccountRef.current = scopeAccountKey;
    unconfirmedRoomDeletesRef.current.clear();
    setRoomDeleteModal(null);
    setGroupCreateAttempt(null);
    setGroupCreateError('');
    if (screen === 'group-create') {
      if (!nav.pop()) nav.resetTo({ screen: 'hub' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeAccountKey]);

  const scopeForBot = (bot: UnifiedBotItem) => {
    const deviceId = bot.hostKind === 'local'
      ? localHost?.deviceId || bot.deviceId || localBots.find(item => item.botId === bot.botId)?.deviceId || ''
      : bot.hostId;
    const center = centerConn.saved?.url || centerConn.url || activeCenter || localStorage.getItem('active-center-url') || '';
    return center && deviceId ? chatStorageKey(center, deviceId, bot.botId) : '';
  };
  const updatePending = (entry: ChatPendingEntry, persist = true) => {
    pendingByBot.current.set(entry.pending.scopeKey, entry);
    let saved = true;
    if (persist) { try { localStorage.setItem(`${entry.pending.scopeKey}:pending`, JSON.stringify(entry)); } catch { saved = false; } }
    if (currentChatScope.current === entry.pending.scopeKey) {
      setChatPending(entry.pending);
      setChatReceipt(entry.receipt);
    }
    return saved;
  };
  const removePending = useCallback((scopeKey: string, requestId: string) => {
    const entry = pendingByBot.current.get(scopeKey);
    if (!entry || entry.pending.requestId !== requestId) return;
    pendingByBot.current.delete(scopeKey);
    try { localStorage.removeItem(`${scopeKey}:pending`); } catch { /* retain safe copy */ }
    if (currentChatScope.current === scopeKey) {
      if (chatSubmissionRef.current?.requestId === requestId) {
        chatSubmissionRef.current = undefined;
      }
      setChatPending(prev => (prev?.requestId === requestId ? undefined : prev));
      setChatReceipt(prev => (prev?.requestId === requestId ? undefined : prev));
    }
  }, []);
  const getCutoff = useCallback((botKey: string, scopeKey: string): number => {
    if (scopeKey && clearedMapRef.current[scopeKey] !== undefined) {
      return clearedMapRef.current[scopeKey];
    }
    return botKey ? (clearedMapRef.current[botKey] ?? 0) : 0;
  }, []);
  const applyCutoff = useCallback((
    botKey: string,
    scopeKey: string,
    entryId: number,
    options?: { recordZero?: boolean },
  ): number => {
    if (!scopeKey || !Number.isSafeInteger(entryId) || entryId < 0) {
      return getCutoff(botKey, scopeKey);
    }
    const existing = clearedMapRef.current[scopeKey];
    const previous = existing !== undefined ? existing : getCutoff(botKey, scopeKey);
    const next = existing !== undefined ? Math.max(existing, entryId) : entryId;
    const shouldWrite = existing === undefined
      ? (entryId > 0 || Boolean(options?.recordZero))
      : next > existing;
    if (shouldWrite) {
      const updated = { ...clearedMapRef.current, [scopeKey]: next };
      clearedMapRef.current = updated;
      writeClearedMap(updated);
      setClearedMap(updated);
    }
    if (next > previous) {
      const cached = chatHistoryCacheRef.current.get(scopeKey);
      if (cached) {
        const pruned = filterHistoryAfterCutoff(cached, next);
        if (pruned.length > 0) chatHistoryCacheRef.current.set(scopeKey, pruned);
        else chatHistoryCacheRef.current.delete(scopeKey);
      }
      updateBotMeta(botKey, { lastText: '', updatedAt: Date.now(), unread: false });
      if (currentChatScope.current === scopeKey) {
        chatHistoryEpoch.current += 1;
        const prunedHistory = filterHistoryAfterCutoff(chatHistoryRef.current, next);
        chatHistoryRef.current = prunedHistory;
        setChatHistory(prunedHistory);
      }
    }
    return existing !== undefined ? next : (shouldWrite ? next : previous);
  }, [getCutoff, updateBotMeta]);
  const applyFetchedHistory = useCallback((
    botKey: string,
    scopeKey: string,
    result: BotHistoryReadResult,
    options?: { updateMeta?: boolean },
  ) => {
    if (result.clearedThroughEntryId !== undefined) {
      applyCutoff(botKey, scopeKey, result.clearedThroughEntryId, { recordZero: true });
    }
    const cutoff = getCutoff(botKey, scopeKey);
    const filteredItems = filterHistoryAfterCutoff(result.items, cutoff);
    if (scopeKey) {
      if (filteredItems.length > 0) chatHistoryCacheRef.current.set(scopeKey, filteredItems);
      else chatHistoryCacheRef.current.delete(scopeKey);
    }
    if (currentChatScope.current === scopeKey) {
      chatHistoryRef.current = filteredItems;
      setChatHistory(filteredItems);
    }
    if (options?.updateMeta) {
      const lastTurn = parseHistoryEntries(filteredItems, cutoff).at(-1);
      if (lastTurn?.text) {
        updateBotMeta(botKey, { lastText: lastTurn.text, unread: false });
      } else if (filteredItems.length === 0 && cutoff > 0) {
        updateBotMeta(botKey, { lastText: '', unread: false });
      }
    }
  }, [applyCutoff, getCutoff, updateBotMeta]);

  const activeChatScope = activeBot ? scopeForBot(activeBot) : '';
  useEffect(() => {
    if (!activeBot || screen !== 'chat' || !activeChatScope) return;
    if (currentChatScope.current === activeChatScope) {
      const entry = pendingByBot.current.get(activeChatScope);
      if (entry && entry.pending.botKey !== activeBot.key) {
        const pending = { ...entry.pending, botKey: activeBot.key };
        chatSubmissionRef.current = pending;
        updatePending({ ...entry, pending });
      }
      return;
    }
    currentChatScope.current = activeChatScope;
    setScopedChatLive(prev => (prev && prev.scopeKey === activeChatScope && prev.botKey === activeBot.key ? prev : undefined));
    const stored = pendingByBot.current.get(activeChatScope) || readChatPending(activeChatScope);
    const entry = stored ? { ...stored, pending: { ...stored.pending, botKey: activeBot.key } } : undefined;
    if (entry) pendingByBot.current.set(activeChatScope, entry);
    chatSubmissionRef.current = entry ? { botKey: activeBot.key, requestId: entry.pending.requestId, afterEntryId: entry.pending.afterEntryId } : undefined;
    setChatPending(entry?.pending);
    setChatReceipt(entry?.receipt);
    setChatDraft(readChatDraft(activeChatScope));
    setChatDraftAttachments(readChatDraftAttachments(activeChatScope));
    setComposerImageError('');
  }, [activeChatScope, activeBot?.key, screen]);

  useEffect(() => {
    const target = selectedChatTarget.current;
    if (screen !== 'chat' || activeBot || !target) return;
    const replacement = allBotItems.find(bot => bot.hostKind === target.hostKind && bot.hostId === target.hostId && bot.botId === target.botId);
    if (replacement) setActiveBotKey(replacement.key);
  }, [screen, activeBot, allBotItems]);

  // Visibility is advisory; reporting it must never delay a chat operation.
  const visibilityChain = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!getOrCreateRemoteClient || !activeBot || screen !== 'chat') return;
    const deviceId = activeBot.hostKind === 'local' ? localHost?.deviceId : activeBot.hostId;
    if (!deviceId) return;
    const botId = activeBot.botId;
    const report = (visible: boolean) => {
      visibilityChain.current = visibilityChain.current.catch(() => {}).then(() =>
        mobileLocalRequest('clientChatVisibility', { deviceId, botId, visible }),
      ).catch(() => {});
    };
    const update = () => report(active && !document.hidden);
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      report(false);
    };
  }, [getOrCreateRemoteClient, active, screen, activeBot?.key, activeBot?.botId, activeBot?.hostKind, activeBot?.hostId, localHost?.deviceId]);

  const mustCreatePrimaryBot = Boolean(localHost?.phase === 'running' && localBotsLoaded && !primaryBot);
  useEffect(() => {
    if (screen !== 'bot-edit' || !mustCreatePrimaryBot) setPrimaryBackNotice(null);
  }, [screen, mustCreatePrimaryBot]);

  const cancelActiveObservation = useCallback(() => {
    if (observeIdRef.current) {
      const id = observeIdRef.current;
      observeIdRef.current = undefined;
      observeTargetRef.current = undefined;
      void BotHost.cancelObservation({ observationId: id }).catch(() => {});
    }
    if (remoteObserveRef.current) {
      const handle = remoteObserveRef.current;
      remoteObserveRef.current = null;
      void handle.close().catch(() => {});
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const handles: { remove(): void }[] = [];
    Promise.all([
      BotHost.addListener('hostFrame', (ev: HostFrameEvent) => {
        if (!alive || ev.observationId !== observeIdRef.current) return;
        if (ev.error) {
          observeIdRef.current = undefined;
          observeTargetRef.current = undefined;
          setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…'));
          return;
        }
        const f = ev.frame;
        if (!f) return;
        const target = observeTargetRef.current?.observationId === ev.observationId ? observeTargetRef.current : undefined;
        if (f.type === 'snapshot') {
          const observedReset = maxResetEntryId(array<Record<string, unknown>>(f.state.history));
          if (observedReset > 0 && target) {
            applyCutoff(target.botKey, target.scopeKey, observedReset);
          }
          if (target) {
            setScopedChatLive({
              scopeKey: target.scopeKey,
              botKey: target.botKey,
              conversationId: target.conversationId,
              transportKey: target.transportKey,
              state: f.state,
            });
          }
        } else if (f.type === 'update') {
          if (Array.isArray(f.changes.history)) {
            const observedReset = maxResetEntryId(array<Record<string, unknown>>(f.changes.history));
            if (observedReset > 0 && target) {
              applyCutoff(target.botKey, target.scopeKey, observedReset);
            }
          }
          // update 只把 changes 合并进同一绑定的已有快照；观察首帧必为 snapshot，update 不单独入栈。
          setScopedChatLive(prev =>
            prev && target && matchesScopedLiveBinding(prev, target)
              ? { ...prev, state: { ...prev.state, ...f.changes } }
              : prev,
          );
        } else if (f.type === 'end') {
          observeIdRef.current = undefined;
          observeTargetRef.current = undefined;
          setScopedChatLive(undefined);
        }
      }),
      BotHost.addListener('voiceEvent', (ev: HostVoiceEvent) => {
        if (!alive) return;
        const activeCap = voiceCapturingRef.current;
        if (ev.type === 'partial') {
          if (activeCap && ev.botId === activeCap.botId && ev.requestId === activeCap.requestId) {
            setVoicePartialText(typeof ev.text === 'string' ? ev.text : '');
          }
          return;
        }
        if (ev.type === 'level') {
          if (activeCap && ev.botId === activeCap.botId && ev.requestId === activeCap.requestId) {
            const nextLevel =
              typeof ev.value === 'number' && Number.isFinite(ev.value)
                ? Math.max(0, Math.min(1, ev.value))
                : 0;
            setVoiceLevel(nextLevel);
          }
          return;
        }
        if (ev.type === 'submitted' || ev.type === 'error') {
          if (activeCap?.requestId === ev.requestId) {
            updateVoiceCapturing(undefined);
            setVoicePartialText('');
            setVoiceLevel(0);
          }
        }
        if (ev.type === 'error' && ev.message) {
          action.setError(ev.message);
        }
        if (ev.type === 'submitted' && ev.receipt && ev.requestId === chatSubmissionRef.current?.requestId) {
          setChatReceipt(ev.receipt as unknown as HostSubmission);
        }
      }),
    ]).then(list => {
      if (alive) handles.push(...list);
      else list.forEach(h => h.remove());
    }).catch(() => {});

    return () => {
      alive = false;
      handles.forEach(h => h.remove());
    };
  }, [connectionEpoch]);

  // 传输失效即撤陈旧 LIVE 与其中待定交互（历史保留只读），恢复后由新快照重建。
  useEffect(() => onMobileStreamFailure(() => { chatLoadGeneration.current += 1; profileLoadGeneration.current += 1; cancelActiveObservation(); setScopedChatLive(undefined); setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…')); }), [cancelActiveObservation]);
  useEffect(() => {
    const resume = () => { if (!document.hidden) setChatResumeEpoch(value => value + 1); };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, []);

  // Load per-Bot Scheduled Tasks
  const loadBotSchedules = useCallback(
    async (bot: UnifiedBotItem) => {
      if (deletingBots.current.has(bot.key)) return;
      const generation = ++scheduleLoadGeneration.current;
      try {
        let rawResult: unknown;
        if (bot.hostKind === 'local') {
          const snap = await ensureLocalHostRunning();
          if (!snap || snap.phase !== 'running') return;
          const latestBots = await syncLocalBots(snap);
          const matched = latestBots.find(b => b.botId === bot.botId);
          const convId = bot.primaryConversationId || matched?.primaryConversationId || '';
          if (!convId) return;
          const env = await BotHost.call({
            method: 'uiScheduleTask',
            params: {
              botId: bot.botId,
              conversationId: convId,
              input: { action: 'list', limit: 50 },
            },
          });
          rawResult = env.result;
        } else if (bot.hostKind === 'remote' && bot.remoteIdentity && remoteClientRef.current) {
          rawResult = await remoteClientRef.current.api.call(bot.remoteIdentity, 'scheduleTask', {
            botId: bot.botId,
            input: { action: 'list', limit: 50 },
          });
        } else {
          setBotScheduleState({
            botKey: bot.key,
            tasks: [],
            exactAlarmGranted: true,
            schedulingError: '',
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
            now: Date.now(),
          });
          return;
        }
        if (generation !== scheduleLoadGeneration.current) return;
        const raw = record(rawResult);
        const tasks = array<BotScheduleTask>(raw.tasks);
        const nextState: BotScheduleState = {
          tasks,
          exactAlarmGranted: raw.exactAlarmGranted !== false,
          schedulingError: typeof raw.schedulingError === 'string' ? raw.schedulingError : '',
          timeZone:
            typeof raw.timeZone === 'string' && raw.timeZone
              ? raw.timeZone
              : Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
          now: typeof raw.now === 'number' ? raw.now : Date.now(),
        };
        setBotScheduleState({ ...nextState, botKey: bot.key });
        const enabledCount = tasks.filter(item => item.enabled !== false).length;
        updateBotMeta(bot.key, { scheduleCount: enabledCount });
      } catch {
        // Ignore transient schedule load error
      }
    },
    [ensureLocalHostRunning, syncLocalBots, updateBotMeta],
  );

  // Load SOUL for the active Bot when entering profile or edit
  const loadBotSoul = useCallback(
    async (bot: UnifiedBotItem) => {
      const generation = ++profileLoadGeneration.current;
      const current = () => generation === profileLoadGeneration.current;
      if (bot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') return;
        try {
          const soulEnv = await BotHost.call({ method: 'getBotSoul', params: { botId: bot.botId } });
          if (!current()) return;
          const parsedSoul = parseBotSoul(soulEnv.result);
          if (parsedSoul) {
            setBotSoul(parsedSoul);
            setSoulDraft(parsedSoul.text);
            setSoulDirty(false);
          }
        } catch {
          // Ignore
        }
      } else if (bot.hostKind === 'remote' && bot.remoteIdentity && remoteClientRef.current) {
        const api = remoteClientRef.current.api;
        try {
          const soulRes = await api.call(bot.remoteIdentity, 'getBotSoul', { botId: bot.botId });
          if (!current()) return;
          const parsedSoul = parseBotSoul(soulRes);
          if (parsedSoul) {
            setBotSoul(parsedSoul);
            setSoulDraft(parsedSoul.text);
            setSoulDirty(false);
          }
        } catch {
          // Ignore
        }
      }
    },
    [ensureLocalHostRunning],
  );

  // Load history and observe when entering Chat View
  const loadBotHistoryAndObserve = useCallback(
    async (bot: UnifiedBotItem) => {
      if (deletingBots.current.has(bot.key)) return;
      cancelActiveObservation();
      // 等这次加载结束再安排重试，避免多片传输被 2 秒定时器反复作废。
      setChatHistoryError('');
      setChatObservationError('');
      const generation = ++chatLoadGeneration.current;
      const current = () => generation === chatLoadGeneration.current && !deletingBots.current.has(bot.key);
      // 同一聊天前台恢复/重连时保留现有 live，直到新快照到达；旧消息只来自实时快照时不会被清空。
      const historyErrorText = t('历史记录暂时无法加载，正在重试…', 'History temporarily unavailable; retrying…');

      // 历史读取与实时观察并行：观察快照尽早呈现最近轮次，全量历史经同 scope+代际 flight 后台补齐。
      // token 在目标切换/代际变化时失效，被丢弃的读在最后边界之后触发一次新读补尾差，不吞增量。
      const scopeKey = currentChatScope.current;
      const historyEpoch = chatHistoryEpoch.current;
      const loadingMarker = { key: scopeKey };
      chatLoadingScope.current = loadingMarker;
      const syncLoading = () =>
        setChatHistoryLoading(Boolean(chatLoadingScope.current) && chatHistoryRef.current.length === 0);
      syncLoading();
      const loadHistory = (read: (fresh: () => boolean) => Promise<BotHistoryReadResult | null>) => {
        const start = async (): Promise<BotHistoryReadResult | null> =>
          sharedHistoryRead(chatHistoryFlights.current, scopeKey, chatHistoryEpoch,
            () => currentChatScope.current === scopeKey && chatHistoryEpoch.current === historyEpoch, read);
        const isCurrent = () => currentChatScope.current === scopeKey && chatHistoryEpoch.current === historyEpoch && current();
        void (async () => {
          try {
            let result = await start();
            if (result === null && isCurrent()) result = await start();
            if (!isCurrent()) return;
            if (result) {
              applyFetchedHistory(bot.key, scopeKey, result, { updateMeta: true });
              setChatHistoryError('');
            }

          } catch {
            if (isCurrent()) setChatHistoryError(historyErrorText);
          } finally {
            if (chatLoadingScope.current === loadingMarker) chatLoadingScope.current = null;
            syncLoading();
          }
        })();
      };

      if (bot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running' || !current()) { if (chatLoadingScope.current === loadingMarker) { chatLoadingScope.current = null; syncLoading(); } return; }
        loadHistory(fresh => fetchBotHistoryPages(async (cursor, limit, chunked) => {
          if (!fresh()) return null;
          const histEnv = await BotHost.call({
            method: 'history',
            params: { botId: bot.botId, limit, ...(chunked ? { chunked: true } : {}), ...(cursor ? { cursor } : {}) },
          });
          return (histEnv.result as HostHistoryPage) ?? null;
        }));
        try {
          const obsId = uuid();
          const binding = buildScopedLiveBinding(
            bot,
            scopeKey,
            snap.deviceId || localHostRef.current?.deviceId || '',
            connectionEpochRef.current,
          );
          observeIdRef.current = obsId;
          observeTargetRef.current = binding ? { observationId: obsId, ...binding } : undefined;
          await BotHost.observe({ observationId: obsId, target: { kind: 'primary', botId: bot.botId } });
          if (current()) setChatObservationError('');
          if (!current()) void BotHost.cancelObservation({ observationId: obsId }).catch(() => {});
        } catch {
          if (current()) { observeIdRef.current = undefined; observeTargetRef.current = undefined; setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…')); }
        }
      } else if (bot.hostKind === 'remote' && bot.remoteIdentity && remoteClientRef.current) {
        const api = remoteClientRef.current.api;
        if (!api.transportConnected || !current()) { if (chatLoadingScope.current === loadingMarker) { chatLoadingScope.current = null; syncLoading(); } return; }
        const identity = bot.remoteIdentity;
        const binding = buildScopedLiveBinding(bot, scopeKey, '', connectionEpochRef.current);
        loadHistory(fresh => fetchBotHistoryPages(async (cursor, limit, chunked) => {
          if (!fresh()) return null;
          const page = await api.call(identity, 'history', {
            botId: bot.botId,
            limit,
            ...(chunked ? { chunked: true } : {}),
            ...(cursor ? { cursor } : {}),
          });
          return (page as unknown as HostHistoryPage) ?? null;
        }));
        try {
          const handle = api.observe(identity, { kind: 'primary', botId: bot.botId }, ev => {
            if (!current()) return;
            if ('error' in ev) { setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…')); return; }
            const frame = ev.frame;
            if (frame.type === 'snapshot') {
              const observedReset = maxResetEntryId(array<Record<string, unknown>>(frame.state.history));
              if (observedReset > 0) {
                applyCutoff(bot.key, scopeKey, observedReset);
              }
              if (binding) setScopedChatLive({ ...binding, state: frame.state });
            } else if (frame.type === 'update') {
              if (Array.isArray(frame.changes.history)) {
                const observedReset = maxResetEntryId(array<Record<string, unknown>>(frame.changes.history));
                if (observedReset > 0) {
                  applyCutoff(bot.key, scopeKey, observedReset);
                }
              }
              setScopedChatLive(prev =>
                prev && binding && matchesScopedLiveBinding(prev, binding)
                  ? { ...prev, state: { ...prev.state, ...frame.changes } }
                  : prev,
              );
            } else if (frame.type === 'end') {
              setScopedChatLive(undefined);
            }
          });
          remoteObserveRef.current = handle;
          void handle.ready.then(() => { if (current()) setChatObservationError(''); }, () => { if (current()) setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…')); });
        } catch {
          remoteObserveRef.current = null;
          if (current()) setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…'));
        }
      } else if (chatLoadingScope.current === loadingMarker) {
        // 目标既非 local 也非可观察 remote：没有历史来源，清掉刚置的加载标记不留死态。
        chatLoadingScope.current = null;
        syncLoading();
      }
    },
    [applyCutoff, applyFetchedHistory, cancelActiveObservation, ensureLocalHostRunning, t],
  );

  // 本机或远端传输更换后，历史读取不再复用旧连接的结果。
  useEffect(() => {
    chatHistoryEpoch.current += 1;
  }, [connectionEpoch, activeBot?.remoteIdentity?.generation, remoteConnected]);

  useEffect(() => {
    if (screen !== 'chat' || !active || !activeBot || document.hidden) return;
    if (activeBot.hostKind === 'remote' && (!remoteConnected || activeBot.online === false)) return;
    void loadBotHistoryAndObserve(activeBot);
    return () => { chatLoadGeneration.current += 1; cancelActiveObservation(); };
    // Rebuild for a new target, transport generation, or foreground transition, not display metadata.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, active, activeBot?.key, activeBot?.primaryConversationId, activeChatScope, activeBot?.remoteIdentity?.generation, activeBot?.online, remoteConnected, chatResumeEpoch, connectionEpoch]);

  useEffect(() => {
    if (!chatLoadError || screen !== 'chat' || !active || document.hidden || (activeBot?.hostKind === 'remote' && (!remoteConnected || activeBot.online === false))) return;
    const timer = window.setTimeout(() => setChatResumeEpoch(value => value + 1), 2000);
    return () => window.clearTimeout(timer);
  }, [chatLoadError, screen, active, activeBot?.hostKind, activeBot?.online, remoteConnected, chatResumeEpoch]);

  const chatBotKey = activeBot?.key;
  const chatBotId = activeBot?.botId;
  const chatHostKind = activeBot?.hostKind;
  const {
    profileId: chatProfileId, targetDeviceId: chatDeviceId,
    generation: chatGeneration, kind: chatConnectionKind,
  } = activeBot?.remoteIdentity ?? {};
  const chatRemoteApi = chatHostKind === 'remote' ? remoteClientRef.current?.api : undefined;
  const chatRemoteConnected = chatHostKind === 'remote' && remoteConnected;
  const chatRequestId = chatPending?.requestId ?? chatReceipt?.requestId;
  const chatReceiptStatus = chatReceipt?.status;

  useEffect(() => {
    if (chatHostKind !== 'remote' || (chatRemoteConnected && activeBot?.online !== false)) return;
    // 断连/目标暂不可达时提示连接恢复，观察 ready 成功后自然清除。
    setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…'));
    const pending = chatPending;
    if (!pending || chatReceipt?.status === 'done' || chatReceipt?.status === 'unanswered') return;
    // pendingByBot entry 是 updatePending 的共享真源：只有匹配当前 request 且无回执的请求才降级。
    const entry = pendingByBot.current.get(pending.scopeKey);
    if (!entry || entry.pending.requestId !== pending.requestId || entry.receipt || entry.pending.phase === 'recovering') return;
    updatePending({ ...entry, pending: { ...entry.pending, phase: 'recovering' } });
  }, [chatHostKind, chatRemoteConnected, activeBot?.online, chatPending?.requestId, chatPending?.scopeKey, chatReceipt?.status, t]);

  // 依赖实际目标与回执标识，不随 Bot 展示对象或历史数组重建而重复补读终态。
  useEffect(() => {
    if (screen !== 'chat' || !chatBotKey || !chatBotId || !chatRequestId) return;
    if (
      chatSubmissionRef.current?.botKey !== chatBotKey ||
      chatSubmissionRef.current.requestId !== chatRequestId
    ) return;
    const submission = chatSubmissionRef.current;
    const requestId = chatRequestId;
    const remoteTarget =
      chatHostKind === 'remote' && chatRemoteConnected && chatRemoteApi && chatProfileId && chatDeviceId &&
      chatGeneration !== undefined && chatConnectionKind
        ? {
            api: chatRemoteApi,
            identity: {
              profileId: chatProfileId, targetDeviceId: chatDeviceId,
              generation: chatGeneration, kind: chatConnectionKind,
            },
          }
        : null;
    if (chatHostKind === 'remote' && !remoteTarget) return;

    const readSubmission = async (): Promise<HostSubmission | null> => {
      if (chatHostKind === 'local') {
        const env = await BotHost.call({ method: 'getSubmission', params: { botId: chatBotId, requestId } });
        return env.result as HostSubmission;
      }
      if (!remoteTarget) return null;
      return (await remoteTarget.api.call(remoteTarget.identity, 'getSubmission', {
        botId: chatBotId,
        requestId,
      })) as unknown as HostSubmission | null;
    };
    const scopeKey = chatPending?.scopeKey ?? currentChatScope.current;
    // flight 内只判 scope+代际有效（不携带本 effect 的 alive/提交身份）；活过本次轮询的共享读
    // 结果照样可用，但不带 stillOwned 的读绝不因本 effect 失效而返回半截。
    const readHistory = async (): Promise<BotHistoryReadResult | null> => {
      const read = (fresh: () => boolean): Promise<BotHistoryReadResult | null> => {
        if (chatHostKind === 'local') {
          return fetchBotHistoryPages(async (cursor, limit, chunked) => {
            if (!fresh()) return null;
            const env = await BotHost.call({
              method: 'history',
              params: { botId: chatBotId, limit, ...(chunked ? { chunked: true } : {}), ...(cursor ? { cursor } : {}) },
            });
            return (env.result as HostHistoryPage) ?? null;
          });
        }
        if (!remoteTarget) return Promise.resolve(null);
        return fetchBotHistoryPages(async (cursor, limit, chunked) => {
          if (!fresh()) return null;
          const page = await remoteTarget.api.call(remoteTarget.identity, 'history', {
            botId: chatBotId,
            limit,
            ...(chunked ? { chunked: true } : {}),
            ...(cursor ? { cursor } : {}),
          });
          return (page as unknown as HostHistoryPage) ?? null;
        });
      };
      if (!scopeKey) return read(() => true);
      return sharedHistoryRead(
        chatHistoryFlights.current, scopeKey, chatHistoryEpoch,
        () => currentChatScope.current === scopeKey, read,
      );
    };

    let alive = true;
    // 语音提交也可能直接返回终态，没有 queued/placed 可供轮询。
    if (chatReceiptStatus === 'done' || chatReceiptStatus === 'unanswered') {
      void readHistory().then(result => {
        if (alive && chatSubmissionRef.current === submission && result) {
          applyFetchedHistory(chatBotKey, scopeKey, result);
        }
      }).catch(() => {});
      return () => {
        alive = false;
      };
    }
    let polling = false;
    const timer = window.setInterval(async () => {
      if (!alive || polling || document.hidden || deletingBots.current.has(chatBotKey) || (chatHostKind === 'local' && localInFlight.current.has(requestId))) return;
      polling = true;
      try {
        const next = await readSubmission();
        if (!alive || deletingBots.current.has(chatBotKey) || chatSubmissionRef.current !== submission || !next || next.requestId !== requestId) return;
        const entry = chatPending && pendingByBot.current.get(chatPending.scopeKey);
        const nextAdmission = (next as TurnAdmissionCarrier).admission ?? null;
        if (next.status !== 'done' && next.status !== 'unanswered') {
          if (entry?.pending.requestId === requestId) updatePending({ pending: { ...entry.pending, phase: 'accepted', admission: nextAdmission }, receipt: next });
          else setChatReceipt(next);
          return;
        }
        // 终态：先回读历史再提交 receipt，避免 receipt 重渲染 cleanup 把 alive 置 false 丢掉后续写入。
        const result = await readHistory().catch(() => null);
        if (!alive || chatSubmissionRef.current !== submission) return;
        if (result) applyFetchedHistory(chatBotKey, scopeKey, result);
        // 回读失败也要落终态 receipt，不能停在生成中；随后同步提交，无新的异步窗口。
        if (entry?.pending.requestId === requestId) updatePending({ pending: { ...entry.pending, phase: 'accepted', admission: nextAdmission }, receipt: next });
        else setChatReceipt(next);
        const cutoff = getCutoff(chatBotKey, scopeKey);
        const oldEpochAnswer =
          cutoff > 0 &&
          submission.afterEntryId < cutoff &&
          (!result || filterHistoryAfterCutoff(result.items, cutoff).length === 0);
        // 摘要只取当前代际的真实答案；无答案（unanswered）或旧代际摘要不覆盖新水位。
        if (next.answerText && !oldEpochAnswer) {
          updateBotMeta(chatBotKey, { lastText: next.answerText, updatedAt: Date.now(), unread: false });
        }
        if (chatHostKind === 'local') void syncLocalBots();
        else void syncRemoteBots();
      } catch {
        // Ignore transient poll error
      } finally {
        polling = false;
      }
    }, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [
    screen, chatBotKey, chatBotId, chatHostKind, chatProfileId, chatDeviceId, chatGeneration,
    chatConnectionKind, chatRemoteApi, chatRemoteConnected, connectionEpoch,
    chatRequestId, chatReceiptStatus, chatResumeEpoch, chatPending?.scopeKey,
    applyFetchedHistory, getCutoff, updateBotMeta, syncLocalBots, syncRemoteBots,
  ]);

  const openBotChat = (bot: UnifiedBotItem, fromScreen?: 'hub' | 'board' | 'tasks' | 'archived-bots') => {
    profileLoadGeneration.current += 1;
    scheduleLoadGeneration.current += 1;
    const scopeKey = scopeForBot(bot);
    const scopeCutoff = getCutoff(bot.key, scopeKey);
    // 同一非空 scope 重进（前台恢复/回主页再进入）保留已加载历史与实时投影；不同 scope 才清空，防跨 Bot/跨 center 串消息。
    const sameScope = Boolean(scopeKey) && currentChatScope.current === scopeKey;
    currentChatScope.current = scopeKey;
    selectedChatTarget.current = { hostKind: bot.hostKind, hostId: bot.hostId, botId: bot.botId };
    const stored = scopeKey ? pendingByBot.current.get(scopeKey) || readChatPending(scopeKey) : undefined;
    const saved = stored ? { ...stored, pending: { ...stored.pending, botKey: bot.key } } : undefined;
    if (saved) pendingByBot.current.set(scopeKey, saved);
    chatSubmissionRef.current = saved ? { botKey: bot.key, requestId: saved.pending.requestId, afterEntryId: saved.pending.afterEntryId } : undefined;
    setActiveBotKey(bot.key);
    if (!sameScope) {
      // 切目标立即 fence 旧加载/观察，防旧 callback 回填新聊天；历史读取代际递进使在途旧读
      // （A→B→A 同 scope 也算）不被复用/回填。同 scopeKey 命中本会话缓存时首屏直出已读消息，避免白屏闪烁。
      chatLoadGeneration.current += 1;
      chatHistoryEpoch.current += 1;
      cancelActiveObservation();
      const cachedHistory = scopeKey
        ? filterHistoryAfterCutoff(chatHistoryCacheRef.current.get(scopeKey) ?? [], scopeCutoff)
        : [];
      chatHistoryRef.current = cachedHistory;
      setChatHistory(cachedHistory);
      setScopedChatLive(undefined);
      setChatObservationError('');
      setChatHistoryError('');
      chatLoadingScope.current = scopeKey ? { key: scopeKey } : null;
      setChatHistoryLoading(Boolean(scopeKey) && cachedHistory.length === 0);
    }
    setChatPending(saved?.pending);
    setChatReceipt(saved?.receipt);
    setChatDraft(scopeKey ? readChatDraft(scopeKey) : '');
    setChatDraftAttachments(scopeKey ? readChatDraftAttachments(scopeKey) : []);
    setComposerImageError('');
    setHubContextMenu(null);
    setComposerMenuOpen(false);
    setChatTopMenuOpen(false);
    setChatSearchOpen(false);
    setChatSearchQuery('');
    setClearNotice('');
    updateBotMeta(bot.key, { unread: false });
    if (fromScreen !== 'tasks') {
      setTaskReturnId(null);
      setJumpedTaskQuote(null);
    }
    chatScrollRestoreRef.current = null;
    chatStickToBottomRef.current = true;
    chatJumpingToBottomRef.current = false;
    setChatHasNewContent(false);
    if (screen === 'bot-edit') {
      nav.replaceTop({ screen: 'chat', botKey: bot.key });
    } else {
      nav.push({ screen: 'chat', botKey: bot.key });
    }
  };

  const [launchTarget, setLaunchTarget] = useState<{ deviceId: string; botId: string } | null>(null);
  const readLaunchTarget = useRef<() => void>(() => {});
  useEffect(() => {
    if (!getOrCreateRemoteClient) return;
    let live = true;
    let reading = false;
    let again = false;
    const read = async () => {
      if (reading) { again = true; return; }
      reading = true;
      try {
        const target = await mobileLocalRequest<{ deviceId: string; botId: string } | null>('clientLaunchTarget');
        if (live && target && typeof target.deviceId === 'string' && target.deviceId && typeof target.botId === 'string' && target.botId) setLaunchTarget(target);
      } catch { /* native may still be restoring IPC */ }
      finally { reading = false; if (live && again) { again = false; void read(); } }
    };
    const resume = () => { if (!document.hidden) void read(); };
    readLaunchTarget.current = () => void read();
    void read();
    window.addEventListener('assistant-open-chat', read);
    document.addEventListener('visibilitychange', resume);
    return () => { live = false; readLaunchTarget.current = () => {}; window.removeEventListener('assistant-open-chat', read); document.removeEventListener('visibilitychange', resume); };
  }, [getOrCreateRemoteClient]);
  useEffect(() => { if (connectionEpoch) readLaunchTarget.current(); }, [connectionEpoch]);

  useEffect(() => {
    if (!launchTarget || document.hidden) return;
    const bot = allBotItems.find(item => item.botId === launchTarget.botId &&
      (item.hostKind === 'remote' ? item.hostId === launchTarget.deviceId :
        (localBots.find(local => local.botId === item.botId)?.deviceId || localHost?.deviceId) === launchTarget.deviceId));
    if (!bot || (bot.hostKind === 'remote' && (!remoteIdentity || !remoteConnected))) return;
    if (screen !== 'chat' || activeBotKey !== bot.key) openBotChat(bot);
    setLaunchTarget(null);
    // The target is consumed once; directory/identity changes only resolve a pending target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchTarget, allBotItems, localBots, localHost?.deviceId, remoteIdentity?.generation, remoteConnected, chatResumeEpoch]);

  /** Scopes 内“打开该 Bot 主聊天”入口：按稳定 (botId, deviceId) 在 allBotItems 中定位后复用 openBotChat。 */
  const handleOpenBot = useCallback((botId: string, deviceId: string) => {
    const bot = allBotItems.find(item => item.botId === botId &&
      (item.hostKind === 'remote' ? item.hostId === deviceId :
        (localBots.find(local => local.botId === item.botId)?.deviceId || localHost?.deviceId) === deviceId));
    if (bot) openBotChat(bot);
  }, [allBotItems, localBots, localHost?.deviceId]);

  // Scopes 消息链接：与移动 Markdown 默认同一 openCenter 原生通道。
  const openScopeLink = useCallback(
    (href: string) => mobileLocalRequest('openCenter', { url: href }),
    [],
  );

  const openBotProfile = (bot: UnifiedBotItem) => {
    setHubContextMenu(null);
    setChatTopMenuOpen(false);
    setComposerMenuOpen(false);
    setActiveBotKey(bot.key);
    nav.push({ screen: 'bot-profile', botKey: bot.key });
    void loadBotSoul(bot);
    void loadBotSchedules(bot);
  };

  const openBotSchedules = (bot: UnifiedBotItem) => {
    setChatTopMenuOpen(false);
    setComposerMenuOpen(false);
    setActiveBotKey(bot.key);
    setScheduleEditing(null);
    setScheduleDeleteTarget(null);
    setScheduleFilter('all');
    nav.push({ screen: 'bot-schedules', botKey: bot.key });
    void loadBotSchedules(bot);
  };

  // 经中心权威通道重新读取 cwd 与 CAS revision；未连中心且为本机 Bot 时直接读取本机 cwd，不报死锁错误。
  const loadEditCwd = useCallback(async (bot: UnifiedBotItem) => {
    const fetchId = ++editCwdFetchRef.current;
    const connectedCenter = Boolean(remoteConnected && remoteIdentity && remoteIdentity.kind !== 'local');
    if (bot.hostKind === 'local' && !connectedCenter) {
      const current = bot.cwd || localHostRef.current?.workspace || '';
      if (editCwdFetchRef.current !== fetchId) return false;
      if (!editCwdDirtyRef.current) setEditCwd(current);
      setEditCwdBaseline(current);
      setEditCwdRevision(null);
      setEditCwdError('');
      return true;
    }
    try {
      const api = await ensureRemoteApi();
      const identity = api?.identity;
      if (!api || !identity) throw new Error(t('中心连接不可用，无法读取工作目录；连接后可重试', 'Center unavailable; cannot load the working directory. Retry once connected'));
      const config = await api.broker(identity, 'center_bot_cwd_get', { deviceId: bot.deviceId, botId: bot.botId });
      if (editCwdFetchRef.current !== fetchId) return false;
      const current = config.value ?? bot.cwd ?? '';
      if (!editCwdDirtyRef.current) setEditCwd(current);
      setEditCwdBaseline(current);
      setEditCwdRevision(config.revision);
      setEditCwdError('');
      return true;
    } catch (error) {
      if (editCwdFetchRef.current !== fetchId) return false;
      setEditCwdRevision(null);
      setEditCwdError(t('工作目录读取失败：', 'Failed to load the working directory: ') + errorText(error));
      return false;
    }
  }, [ensureRemoteApi, remoteConnected, remoteIdentity, t]);

  // 资料页即编辑页：进入/换 Bot 时把共享编辑态预填为当前 Bot。
  const prefillBotProfileEdit = (bot: UnifiedBotItem) => {
    editCwdFetchRef.current++;
    setEditMode('edit');
    setEditMakePrimary(Boolean(bot.isPrimary));
    setEditName(bot.role);
    setEditSubtitle(bot.description ?? '');
    editCwdDirtyRef.current = false;
    setEditCwd(bot.cwd || localHost?.workspace || '');
    setEditCwdRevision(null);
    setEditCwdError('');
    setEditSaveErrors({});
    setEditCwdSaved(false);
    setEditAvatarPreset(resolveBotAvatarPreset(botAvatarKey(bot), bot.role, bot.isPrimary));
  };

  // 编辑期间以完整身份（设备+bot+连接 profile/generation）为键重读修订；
  // 离开表单/切 create/换目标即失效旧请求，迟到结果不写新表单。
  const editCwdIdentity = activeBot
    ? JSON.stringify([
        activeCenter, activeBot.deviceId, activeBot.botId,
        remoteIdentity?.profileId, remoteIdentity?.generation,
      ])
    : '';
  useEffect(() => {
    if (!activeBot || (screen !== 'bot-profile-manage' && !(screen === 'bot-edit' && editMode === 'edit'))) return;
    void loadEditCwd(activeBot);
    return () => {
      // 身份/表单变化：旧修订立即作废，绝不允许旧 CAS 凭据写新目标。
      editCwdFetchRef.current++;
      setEditCwdRevision(null);
    };
  }, [screen, editMode, editCwdIdentity, remoteConnected, loadEditCwd]);

  const openCreateBotPage = useCallback((forcePrimary = false) => {
    setHubAddMenuOpen(false);
    const nextPreset = forcePrimary
      ? JARVIS_AVATAR_PRESET
      : GROK_AVATAR_PRESETS[listBotItems.length % GROK_AVATAR_PRESETS.length];
    editCwdFetchRef.current++;
    editCwdDirtyRef.current = false;
    setEditMode('create');
    setEditMakePrimary(forcePrimary);
    setEditName(forcePrimary ? DEFAULT_PRIMARY_ROLE : '');
    setEditSubtitle('');
    setEditCwd('');
    setEditCwdRevision(null);
    setEditCwdError('');
    setEditTargetHost('local');
    setEditModelRef('');
    setEditAvatarPreset(nextPreset);
    setEditInitialSoul('');
    setSoulDraft('');
    setSoulDirty(false);
    setEditVoiceTone('未设置'); // i18n-ok
    setEditVoiceSpeed('1x');
    setEditVoiceLang('自动'); // i18n-ok
    nav.push({ screen: 'bot-edit' });
  }, [listBotItems.length, nav.push]);

  useEffect(() => {
    if (screen !== 'bot-edit' || editMode !== 'create' || !remoteConnected || !remoteIdentity || !remoteClientRef.current) {
      setCreateModelPicker(null);
      setCreateModelLoading(false);
      return;
    }
    let cancelled = false;
    setCreateModelLoading(true);
    void remoteClientRef.current.api
      .broker(remoteIdentity, 'center_model_picker_get', {})
      .then(picker => {
        if (!cancelled) setCreateModelPicker(picker);
      })
      .catch(() => {
        if (!cancelled) setCreateModelPicker(null);
      })
      .finally(() => {
        if (!cancelled) setCreateModelLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [screen, editMode, remoteConnected, remoteIdentity]);

  const resolveGroupWriteApi = useCallback((deviceId: string): DesktopPanelApi | null => {
    const mapped = roomWriteTargetApiMap.get(deviceId);
    if (mapped?.transportConnected && mapped.identity) return mapped;
    const liveApi = remoteClientRef.current?.api;
    const liveIdentity = liveApi?.identity;
    if (!liveApi || !liveIdentity || !liveApi.transportConnected) return null;
    if (liveIdentity.kind === 'local' && liveIdentity.targetDeviceId !== deviceId) return null;
    const online = deviceId === localHostRef.current?.deviceId
      ? localHostRef.current?.phase === 'running'
      : remoteDevices.some(d => d.deviceId === deviceId && d.online);
    if (!online) return null;
    try {
      return targetApi(liveApi, deviceId, true);
    } catch {
      return null;
    }
  }, [roomWriteTargetApiMap, remoteDevices]);

  const pickGroupAuthorityDeviceId = useCallback((members: readonly MessageMember[]): string => {
    const localId = localHostRef.current?.deviceId ?? localHost?.deviceId;
    if (localId && members.some(m => m.deviceId === localId)) {
      if (resolveGroupWriteApi(localId)) return localId;
      if (localHostRef.current?.phase === 'running' && (!getOrCreateRemoteClient || centerConn.ready)) {
        return localId;
      }
    }
    for (const member of members) {
      if (resolveGroupWriteApi(member.deviceId)) return member.deviceId;
    }
    return '';
  }, [localHost?.deviceId, resolveGroupWriteApi, getOrCreateRemoteClient, centerConn.ready]);

  const openCreateGroupPage = useCallback(() => {
    setHubAddMenuOpen(false);
    setHubContextMenu(null);
    setGroupSearchQuery('');
    if (groupCreateAttempt) {
      setGroupTitle(groupCreateAttempt.title ?? '');
      setGroupMembers(groupCreateAttempt.members);
    } else {
      setGroupTitle('');
      setGroupMembers([]);
      setGroupCreateError('');
    }
    if (getOrCreateRemoteClient) {
      void ensureRemoteApi().then(() => syncRemoteBots());
    }
    nav.push({ screen: 'group-create' });
  }, [groupCreateAttempt, getOrCreateRemoteClient, ensureRemoteApi, syncRemoteBots, nav.push]);

  const toggleGroupMember = useCallback((bot: { deviceId: string; botId: string }) => {
    if (groupCreating || groupCreateAttempt) return;
    setGroupCreateError('');
    setGroupMembers(prev => {
      const exists = prev.some(m => m.botId === bot.botId);
      if (exists) return prev.filter(m => m.botId !== bot.botId);
      if (prev.length >= 64) return prev;
      return [...prev, { deviceId: bot.deviceId, botId: bot.botId }];
    });
  }, [groupCreating, groupCreateAttempt]);

  const discardGroupCreateAttempt = useCallback(() => {
    if (groupCreating) return;
    setGroupCreateAttempt(null);
    setGroupCreateError('');
  }, [groupCreating]);

  const handleCreateGroup = useCallback(async () => {
    if (groupCreateFlight.current || groupCreating) return;
    let attempt = groupCreateAttempt;
    if (!attempt) {
      if (groupMembers.length < 2) {
        setGroupCreateError(t('群聊至少需要选择 2 个 Bot。', 'Select at least 2 bots for a group chat.'));
        return;
      }
      if (groupMembers.length > 64) {
        setGroupCreateError(t('群聊最多支持 64 个成员。', 'A group chat supports up to 64 bots.'));
        return;
      }
      const trimmedTitle = groupTitle.trim();
      if ([...trimmedTitle].length > 120) {
        setGroupCreateError(t('群名称最多 120 个字符。', 'Group name must be 120 characters or fewer.'));
        return;
      }
      if (getOrCreateRemoteClient && !remoteClientRef.current) {
        await ensureRemoteApi();
      }
      const targetDeviceId = pickGroupAuthorityDeviceId(groupMembers);
      if (!targetDeviceId) {
        setGroupCreateError(
          t('所选成员所在设备当前均离线或未连接中心，请至少包含一位在线设备上的 Bot。',
            'All selected bots are on offline or disconnected hosts. Include at least one bot on an online host.'),
        );
        return;
      }
      attempt = {
        requestId: uuid(),
        targetDeviceId,
        profileId: remoteClientRef.current?.api.identity?.profileId,
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        members: groupMembers.map(m => ({ deviceId: m.deviceId, botId: m.botId })),
      };
    } else if (getOrCreateRemoteClient && !remoteClientRef.current) {
      await ensureRemoteApi();
    }

    const wApi = resolveGroupWriteApi(attempt.targetDeviceId);
    const wIdentity = wApi?.identity;
    const canFallbackLocal =
      attempt.targetDeviceId === localHostRef.current?.deviceId &&
      localHostRef.current?.phase === 'running' &&
      (!getOrCreateRemoteClient || centerConn.ready);
    if (!(wApi && wIdentity && wApi.transportConnected) && !canFallbackLocal) {
      setGroupCreateError(
        groupCreateAttempt
          ? t('目标权威节点当前未连接或离线，请恢复连接后再按原请求重试。',
              'Authority host is offline or disconnected; reconnect before retrying with the original request.')
          : t('目标节点当前未连接或离线，请恢复连接后再试。', 'Target host is offline or disconnected; reconnect and retry.'),
      );
      return;
    }

    groupCreateFlight.current = true;
    setGroupCreating(true);
    setGroupCreateError('');
    try {
      const input = {
        requestId: attempt.requestId,
        kind: 'room' as const,
        members: attempt.members,
        ...(attempt.title ? { title: attempt.title } : {}),
      };
      const createdScope: ScopeInfo = wApi && wIdentity && wApi.transportConnected
        ? await wApi.mutateIntent(wIdentity, 'createScope', { input })
        : ((await BotHost.call({ method: 'createScope', params: { input } })).result as ScopeInfo);

      setGroupCreateAttempt(null);
      setGroupCreateError('');
      setGroupTitle('');
      setGroupMembers([]);
      setGroupSearchQuery('');
      void refreshRoomConversationsRef.current();

      const localId = localHostRef.current?.deviceId;
      const readSource = attempt.targetDeviceId === localId
        ? scopeConversationSources.find(s => s.api === localScopeApi)
        : scopeConversationSources.find(s => s.identity.targetDeviceId === attempt.targetDeviceId);
      const readApi =
        readSource?.api ??
        (attempt.targetDeviceId === localId && localScopeApi ? localScopeApi : wApi);
      const fallbackIdentity: DesktopIdentity =
        wIdentity ??
        localScopeApi?.identity ?? {
          profileId: 'local',
          kind: 'local',
          generation: 0,
          targetDeviceId: attempt.targetDeviceId,
        };
      if (readApi) {
        openScopeConversation({
          key: createdScope.scope.scopeId,
          api: readApi,
          identity: readSource?.identity ?? fallbackIdentity,
          scope: createdScope,
          title: conversationTitle(createdScope.scope, knownBots),
          lastPreview: '',
          lastActivityAt: null,
        });
      } else {
        nav.resetTo({ screen: 'hub' });
      }
    } catch (err) {
      const code = (err as { code?: string })?.code ?? '';
      const outcome = (err as { outcome?: string })?.outcome;
      const definite =
        outcome === 'not-sent' ||
        (outcome === 'responded' &&
          [
            'INVALID_INPUT',
            'INVALID_ARGUMENT',
            'SCOPE_FORBIDDEN',
            'REQUEST_CONFLICT',
            'CENTER_OFFLINE',
            'RUNTIME_BUSY',
            'OFFLINE',
            'CONTROL_UNAVAILABLE',
          ].includes(code)) ||
        (outcome === undefined &&
          [
            'INVALID_INPUT',
            'INVALID_ARGUMENT',
            'SCOPE_FORBIDDEN',
            'REQUEST_CONFLICT',
            'CENTER_OFFLINE',
            'RUNTIME_BUSY',
          ].includes(code));
      if (definite) {
        setGroupCreateAttempt(null);
        setGroupCreateError(errorText(err));
      } else {
        setGroupCreateAttempt(attempt);
        setGroupCreateError(
          t(`${errorText(err)}（结果未确认，已冻结原请求 ID，可按原请求安全重试）`,
            `${errorText(err)} (Outcome unconfirmed; original request ID frozen for idempotent retry)`),
        );
      }
    } finally {
      groupCreateFlight.current = false;
      if (localBotsMounted.current) setGroupCreating(false);
    }
  }, [
    groupCreating,
    groupCreateAttempt,
    groupMembers,
    groupTitle,
    getOrCreateRemoteClient,
    ensureRemoteApi,
    pickGroupAuthorityDeviceId,
    resolveGroupWriteApi,
    centerConn.ready,
    scopeConversationSources,
    localScopeApi,
    knownBots,
    nav.resetTo,
    t,
  ]);

  useEffect(() => {
    if (mustCreatePrimaryBot && screen === 'hub') {
      openCreateBotPage(true);
    }
  }, [mustCreatePrimaryBot, screen, openCreateBotPage]);

  const openAvatarPicker = (currentPreset: GrokAvatarPreset) => {
    setDraftAvatar({ ...currentPreset });
    setAvatarTab('shape');
    nav.push({ screen: 'bot-avatar' });
  };

  const [slashBusy, setSlashBusy] = useState<SlashCommandName>();
  const slashBusyRef = useRef(false);
  /** 停止失败单独提示，与 action.error（发送等）分开保留；成功由 Host activity stopped 呈现。 */
  const [stopError, setStopError] = useState('');
  const setActionError = action.setError;
  const invalidateBoard = board.invalidate;

  // /clear 与 /compact 都先等后端成功，再用服务端边界重置本地可见历史；失败保留草稿与原历史。
  // 返回 true 表示服务端已成功（即使 UI 已切到别的会话），false 表示 UI 切走后不再报错的过期结果。
  const runSlashCommand = useCallback(async (command: SlashCommandName): Promise<boolean> => {
    const bot = activeBot;
    if (!bot) throw new Error(t('请先选择一个 Bot。', 'Select a bot first.'));
    if (slashBusyRef.current) throw new Error(t('上一个命令仍在执行，请稍候。', 'The previous command is still running.'));
    if (chatPending?.botKey === bot.key && chatPending.phase !== 'accepted') {
      throw new Error(t('原请求尚未确认，不能清空或压缩。', 'The original request is unconfirmed; clear or compact is blocked.'));
    }
    if (bot.archivedAt) throw new Error(t('该 Bot 已归档，请先恢复后再操作。', 'This bot is archived. Unarchive it first.'));
    const scopeKey = scopeForBot(bot);
    if (!scopeKey) throw new Error(t('目标身份尚未就绪，草稿已保留。', 'Target identity unavailable; draft retained.'));
    const boardKey = botBoardKey(pinStorageScope, bot.deviceId, bot.botId);
    const draftSnapshot = readChatDraft(scopeKey);
    const preClearPendingRequestId = pendingByBot.current.get(scopeKey)?.pending.requestId;
    const preClearSubmission = chatSubmissionRef.current?.botKey === bot.key ? chatSubmissionRef.current : undefined;
    slashBusyRef.current = true;
    setSlashBusy(command);
    setClearNotice(command === '/clear'
      ? t('正在清空对话…', 'Clearing conversation…')
      : t('正在压缩上下文…', 'Compacting context…'));
    try {
      if (bot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') throw new Error(t('本机服务未运行，草稿已保留。', 'Local host is not running; draft retained.'));
      } else if (!bot.remoteIdentity || !remoteClientRef.current || !remoteConnected) {
        throw new Error(t('目标离线，草稿已保留。', 'Target offline; draft retained.'));
      }
      let cleared: ClearHistoryResult | undefined;
      let compacted: CompactResult | undefined;
      try {
        if (bot.hostKind === 'local') {
          const env = await BotHost.call({ method: command === '/clear' ? 'clearHistory' : 'compact', params: { botId: bot.botId } });
          if (command === '/clear') cleared = env.result as ClearHistoryResult;
          else compacted = env.result as CompactResult;
        } else {
          const result = await remoteClientRef.current!.api.call(
            bot.remoteIdentity!,
            command === '/clear' ? 'clearHistory' : 'compact',
            { botId: bot.botId },
          );
          if (command === '/clear') cleared = result as unknown as ClearHistoryResult;
          else compacted = result as unknown as CompactResult;
        }
      } catch (rpcError) {
        if (command !== '/clear') throw rpcError;
        const kind = classifyClearError(rpcError);
        if (kind === 'busy') {
          throw makeClearError(
            t('Bot 正在执行任务，暂无法清空对话；请等待完成或先停止后再试。', 'Bot is busy with active work; conversation was not cleared. Wait for it to finish or stop it first.'),
            'RUNTIME_BUSY',
            'responded',
          );
        }
        if (kind === 'unknown') {
          // 结果未确认：绝不自动重发、不按读到新边界推断成功或清草稿/待发，只复用现有单飞刷新核对服务端状态。
          if (currentChatScope.current === scopeKey) {
            chatHistoryEpoch.current += 1;
            setChatResumeEpoch(value => value + 1);
          }
          const errCode = typeof (rpcError as { code?: unknown })?.code === 'string'
            ? (rpcError as { code: string }).code
            : 'UNCONFIRMED';
          throw makeClearError(
            t('清空结果未确认，已刷新历史核实状态（未自动重发），草稿与待发保留。', 'Clear outcome unconfirmed; refreshing history to verify without auto-retry. Draft and pending retained.'),
            errCode,
            'unconfirmed',
          );
        }
        throw rpcError;
      }
      if (command === '/clear') {
        invalidateBoard(boardKey);
        applyCutoff(bot.key, scopeKey, cleared?.clearedThroughEntryId ?? 0, { recordZero: true });
        chatHistoryCacheRef.current.delete(scopeKey);
        if (preClearPendingRequestId) removePending(scopeKey, preClearPendingRequestId);
        // 仅当当前草稿正是 "/clear" 命令文本时清掉；保留无关草稿、图片附件与文件引用。
        if (draftSnapshot.trim() === '/clear' && readChatDraft(scopeKey) === draftSnapshot) {
          writeChatDraft(scopeKey, '');
        }
        updateBotMeta(bot.key, { lastText: '', updatedAt: Date.now(), unread: false });
        if (currentChatScope.current !== scopeKey) return true;
        if (preClearSubmission && chatSubmissionRef.current === preClearSubmission) {
          chatSubmissionRef.current = undefined;
          setChatReceipt(prev => (prev?.requestId === preClearSubmission.requestId ? undefined : prev));
        }
        setStopError('');
        setActionError('');
        setComposerMenuOpen(false);
        setChatTopMenuOpen(false);
        chatHistoryEpoch.current += 1;
        chatHistoryRef.current = [];
        setChatHistory([]);
        setScopedChatLive(prev =>
          prev && prev.scopeKey === scopeKey
            ? {
                ...prev,
                state: {
                  ...prev.state,
                  ...(prev.state.durableWaits !== undefined ? { durableWaits: [] } : {}),
                },
              }
            : prev,
        );
        setChatObservationError('');
        setChatHistoryError('');
        if (draftSnapshot.trim() === '/clear') {
          setChatDraft(previous => previous.trim() === '/clear' ? '' : previous);
        }
        const doneText = t('已清空当前对话并重置上下文', 'Conversation cleared and context reset');
        setClearNotice(doneText);
        window.setTimeout(() => setClearNotice(prev => prev === doneText ? '' : prev), 2500);
        return true;
      }
      // 切换 Bot 后只影响服务端，不清新 Bot 的草稿/UI。
      if (currentChatScope.current !== scopeKey) return true;
      setComposerMenuOpen(false);
      setChatTopMenuOpen(false);
      // /compact 成功后才清掉实际命令草稿；若等待期间已写入新文本则保留，不误删。
      if (draftSnapshot.trim() === command) {
        if (readChatDraft(scopeKey) === draftSnapshot) writeChatDraft(scopeKey, '');
        setChatDraft(previous => previous.trim() === command ? '' : previous);
      }
      const compactText = compacted?.compacted
        ? t('已压缩较早的上下文', 'Earlier context compacted')
        : t('没有可压缩的历史', 'Nothing to compact');
      setClearNotice(compactText);
      window.setTimeout(() => setClearNotice(prev => prev === compactText ? '' : prev), 2500);
      return true;
    } catch (error) {
      // 异步完成时已切到别的会话：不向新会话写错误/提示，也不把失败当成成功。
      if (currentChatScope.current !== scopeKey) return false;
      setClearNotice('');
      throw error;
    } finally {
      slashBusyRef.current = false;
      setSlashBusy(undefined);
    }
  }, [activeBot, applyCutoff, chatPending, ensureLocalHostRunning, invalidateBoard, pinStorageScope, remoteConnected, removePending, setActionError, t, updateBotMeta]);

  /** 停止在途按 bot.key 去重：切换 Bot 不复用其他 Bot 的 abort Promise。 */
  const stopInFlightRef = useRef(new Map<string, Promise<unknown>>());
  const [stopping, setStopping] = useState<Set<string>>(() => new Set());

  const sendMessage = (delivery: TurnDeliveryMode = 'followUp') =>
    action.run(async () => {
      const bot = activeBot;
      if (!bot) return;
      if (bot.hostKind === 'remote') {
        setOfflineNotice({ botKey: bot.key, text: t('目标离线，草稿已保留。', 'Target offline; draft retained.') });
        return;
      }
      if (deletingBots.current.has(bot.key) || (chatPending?.botKey === bot.key && chatPending.phase !== 'accepted')) return;
      if (bot.archivedAt) throw new Error(t('该 Bot 已归档，请先恢复后再发送消息', 'This bot is archived. Unarchive it first.'));
      if (imageUploading || editSubmitting) return;
      const botScopeKey = scopeForBot(bot);
      const botLive = chatLiveForBot(bot, botScopeKey);
      const effectiveLive = isStaleLiveState(botLive, getCutoff(bot.key, botScopeKey)) ? undefined : botLive;
      const currentActivity = resolveBotActivity(effectiveLive);
      if (
        stopping.has(bot.key) ||
        currentActivity.phase === 'stopping' ||
        isBotPreLlmPhase(currentActivity.phase)
      ) {
        return;
      }
      const draftSnapshot = chatDraft;
      const trimmed = draftSnapshot.trim();
      const draftAttachmentMetas = [...chatDraftAttachments];
      if (!trimmed && draftAttachmentMetas.length === 0) return;
      const command = parseSlashCommand(trimmed);
      if (command && draftAttachmentMetas.length === 0) { await runSlashCommand(command); return; }
      if (!centerConn.ready || centerConn.status?.state === 'disconnected') {
        setOfflineNotice({ botKey: bot.key, text: t('中心离线，草稿已保留。', 'Center offline; draft retained.') });
        return;
      }
      const scopeKey = scopeForBot(bot);
      if (!scopeKey) throw new Error(t('目标身份尚未就绪，草稿已保留。', 'Target identity unavailable; draft retained.'));
      const capturedTaskScopeKey = taskScopeKey;
      const linkedTaskSnapshot = activeBotLinkedTask;
      const taskPrefix = activeBotTaskPrefix;
      const composedText = taskPrefix ? (trimmed ? `${taskPrefix}${trimmed}` : taskPrefix.trimEnd()) : trimmed;
      const attachmentIds = draftAttachmentMetas.map((a) => a.id);
      const submission: ChatPending = {
        botKey: bot.key, scopeKey, requestId: uuid(), text: composedText,
        ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
        ...(delivery ? { delivery } : {}),
        phase: 'sending',
        submittedAt: Date.now(),
        afterEntryId: Math.max(maxHistoryEntryId(chatHistory), Number(effectiveLive?.lastEntryId) || 0, getCutoff(bot.key, scopeKey)),
      };
      chatSubmissionRef.current = submission;
      updatePending({ pending: submission }, false);
      forceChatScrollBottom();
      setChatDraft('');
      setChatDraftAttachments([]);
      setComposerImageError('');
      setComposerMenuOpen(false);
      setChatTopMenuOpen(false);
      localInFlight.current.add(submission.requestId);
      const stillOwned = () => pendingByBot.current.get(scopeKey)?.pending.requestId === submission.requestId;
      const restore = () => {
        if (!stillOwned()) return;
        const newer = readChatDraft(scopeKey);
        const restored = newer && newer !== draftSnapshot ? `${draftSnapshot}
${newer}` : draftSnapshot;
        const existingAtts = readChatDraftAttachments(scopeKey);
        const sameAtts = existingAtts.length === draftAttachmentMetas.length &&
          existingAtts.every((a, i) => a.id === draftAttachmentMetas[i]?.id);
        const restoredAtts = existingAtts.length > 0 && !sameAtts
          ? dedupeAttachmentMetas(existingAtts, draftAttachmentMetas, IMAGE_MAX_COUNT)
          : draftAttachmentMetas;
        const savedText = writeChatDraft(scopeKey, restored);
        const savedAtt = writeChatDraftAttachments(scopeKey, restoredAtts);
        if (savedText && savedAtt) removePending(scopeKey, submission.requestId);
        else updatePending({ pending: { ...submission, phase: 'recovering' } }, false);
        if (currentChatScope.current === scopeKey) {
          setChatDraft(restored);
          setChatDraftAttachments(restoredAtts);
          if (!savedText || !savedAtt) setClearNotice(t('草稿未能保存，请保持页面打开。', 'Draft could not be saved; keep this page open.'));
        }
      };
      try {
        // Let React paint the optimistic turn before persistent storage or IPC.
        await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        if (!stillOwned()) return;
        if (!updatePending({ pending: submission })) { restore(); if (currentChatScope.current === scopeKey) throw new Error(t('无法保存请求，未发送。', 'Cannot save request; not sent.')); return; }
        if (readChatDraft(scopeKey) === draftSnapshot) writeChatDraft(scopeKey, '');
        writeChatDraftAttachments(scopeKey, []);
        const snap = await ensureLocalHostRunning();
        const center = centerConnectionRef.current;
        if (!snap || snap.phase !== 'running' || !snap.deviceId || !center.ready || center.status?.state === 'disconnected' || chatStorageKey(center.saved?.url || center.url || '', snap.deviceId, bot.botId) !== scopeKey) {
          restore();
          if (currentChatScope.current === scopeKey) setOfflineNotice({ botKey: bot.key, text: t('目标离线，草稿已保留。', 'Target offline; draft retained.') });
          return;
        }
        updateBotMeta(bot.key, { lastText: trimmed, updatedAt: Date.now(), unread: false });
        let receipt: HostSubmission;
        try {
          const result = await BotHost.call({
            method: 'submit',
            params: {
              botId: bot.botId,
              requestId: submission.requestId,
              text: composedText,
              ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
              ...(delivery === 'steer' ? { delivery: 'steer' } : {}),
            },
          });
          receipt = result.result as HostSubmission;
          mobileHaptic('tick');
          if (linkedTaskSnapshot && trimmed) {
            handleTaskMessageAccepted(linkedTaskSnapshot, trimmed, bot, capturedTaskScopeKey);
          }
        } catch (error) {
          if (stillOwned()) {
            if (isDefiniteSendFailure(error)) restore();
            else updatePending({ pending: { ...submission, phase: 'recovering' } });
          }
          if (currentChatScope.current === scopeKey && isDefiniteSendFailure(error)) throw error;
          return;
        }
        if (!stillOwned()) return;
        updatePending({ pending: { ...submission, phase: 'accepted', admission: (receipt as TurnAdmissionCarrier).admission ?? null }, receipt });
        const result = await sharedHistoryRead(
          chatHistoryFlights.current, scopeKey, chatHistoryEpoch,
          () => currentChatScope.current === scopeKey,
          fresh => fetchBotHistoryPages(async (cursor, limit, chunked) => {
            if (!fresh()) return null;
            const env = await BotHost.call({
              method: 'history',
              params: { botId: bot.botId, limit, ...(chunked ? { chunked: true } : {}), ...(cursor ? { cursor } : {}) },
            });
            return (env.result as HostHistoryPage) ?? null;
          }),
        ).catch(() => null);
        if (currentChatScope.current === scopeKey && stillOwned() && result) {
          applyFetchedHistory(bot.key, scopeKey, result);
        }
      } finally {
        localInFlight.current.delete(submission.requestId);
      }
    });

  const submitEditedTurn = () =>
    action.run(async () => {
      const bot = activeBot;
      const currentEdit = editingTurn;
      if (!bot || !currentEdit || currentEdit.botKey !== bot.key || editSubmitting || imageUploading) return;
      if (bot.archivedAt) throw new Error(t('该 Bot 已归档，请先恢复后再编辑消息', 'This bot is archived. Unarchive it first.'));
      const scopeKey = scopeForBot(bot);
      if (!scopeKey) throw new Error(t('目标身份尚未就绪。', 'Target identity unavailable.'));
      const botLive = chatLiveForBot(bot, scopeKey);
      const effectiveLive = isStaleLiveState(botLive, getCutoff(bot.key, scopeKey)) ? undefined : botLive;
      const currentActivity = resolveBotActivity(effectiveLive);
      if (isBotActivityBusy(currentActivity) || stopping.has(bot.key) || (chatPending?.botKey === bot.key && chatPending.phase !== 'accepted')) {
        throw new Error(t('Bot 正忙，无法编辑历史消息', 'Bot is busy; cannot edit historical messages.'));
      }
      const trimmed = currentEdit.text.trim();
      const attachmentIds = currentEdit.attachments.map(a => a.id);
      if (!trimmed && attachmentIds.length === 0) return;
      const requestId = uuid();
      const targetEntryId = currentEdit.entryId;
      setEditSubmitting(true);
      try {
        let receipt: HostSubmission;
        if (bot.hostKind === 'local') {
          if (!centerConn.ready || centerConn.status?.state === 'disconnected') {
            setOfflineNotice({ botKey: bot.key, text: t('中心离线，编辑内容已保留。', 'Center offline; edit retained.') });
            return;
          }
          const snap = await ensureLocalHostRunning();
          if (!snap || snap.phase !== 'running') {
            setOfflineNotice({ botKey: bot.key, text: t('目标离线，编辑内容已保留。', 'Target offline; edit retained.') });
            return;
          }
          const env = await BotHost.call({
            method: 'editMessage',
            params: {
              botId: bot.botId,
              requestId,
              entryId: targetEntryId,
              text: trimmed,
              ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
            },
          });
          receipt = env.result as HostSubmission;
        } else {
          if (!bot.remoteIdentity || !remoteClientRef.current || !remoteConnected || bot.online === false) {
            setOfflineNotice({ botKey: bot.key, text: t('目标离线，编辑内容已保留。', 'Target offline; edit retained.') });
            return;
          }
          const res = await remoteClientRef.current.api.call(bot.remoteIdentity, 'editMessage', {
            botId: bot.botId,
            requestId,
            entryId: targetEntryId,
            text: trimmed,
            ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
          });
          receipt = res as unknown as HostSubmission;
        }
        mobileHaptic('tick');
        setEditingTurn(prev => (prev?.entryId === targetEntryId && prev.botKey === bot.key ? null : prev));
        chatHistoryEpoch.current += 1;
        const cachedBeforeEdit = chatHistoryCacheRef.current.get(scopeKey);
        if (cachedBeforeEdit) {
          const trimmedCache = cachedBeforeEdit.filter(item => Number(item.id) < targetEntryId);
          if (trimmedCache.length > 0) chatHistoryCacheRef.current.set(scopeKey, trimmedCache);
          else chatHistoryCacheRef.current.delete(scopeKey);
        }
        if (currentChatScope.current === scopeKey) {
          setChatHistory(prev => prev.filter(item => Number(item.id) < targetEntryId));
          setScopedChatLive(prev =>
            prev && prev.scopeKey === scopeKey
              ? {
                  ...prev,
                  state: {
                    ...prev.state,
                    history: Array.isArray(prev.state.history)
                      ? prev.state.history.filter(item => Number(item.id) < targetEntryId)
                      : prev.state.history,
                    ...(prev.state.durableWaits !== undefined ? { durableWaits: [] } : {}),
                  },
                }
              : prev,
          );
        }
        const submission: ChatPending = {
          botKey: bot.key,
          scopeKey,
          requestId,
          text: trimmed,
          ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
          phase: 'accepted',
          submittedAt: Date.now(),
          afterEntryId: Math.max(0, targetEntryId - 1),
          admission: (receipt as TurnAdmissionCarrier).admission ?? null,
        };
        if (currentChatScope.current === scopeKey) chatSubmissionRef.current = submission;
        updatePending({ pending: submission, receipt });
        forceChatScrollBottom();
        updateBotMeta(bot.key, { lastText: trimmed, updatedAt: Date.now(), unread: false });
        const readPages = async () => {
          if (bot.hostKind === 'local') {
            return fetchBotHistoryPages(async (cursor, limit, chunked) => {
              const env = await BotHost.call({
                method: 'history',
                params: { botId: bot.botId, limit, ...(chunked ? { chunked: true } : {}), ...(cursor ? { cursor } : {}) },
              });
              return (env.result as HostHistoryPage) ?? null;
            });
          }
          const api = remoteClientRef.current?.api;
          const identity = bot.remoteIdentity;
          if (!api || !identity) return null;
          return fetchBotHistoryPages(async (cursor, limit, chunked) => {
            const page = await api.call(identity, 'history', {
              botId: bot.botId,
              limit,
              ...(chunked ? { chunked: true } : {}),
              ...(cursor ? { cursor } : {}),
            });
            return (page as unknown as HostHistoryPage) ?? null;
          });
        };
        const freshResult = await sharedHistoryRead(
          chatHistoryFlights.current,
          scopeKey,
          chatHistoryEpoch,
          () => currentChatScope.current === scopeKey,
          () => readPages(),
        ).catch(() => null);
        if (freshResult) {
          applyFetchedHistory(bot.key, scopeKey, freshResult);
        }
      } finally {
        setEditSubmitting(false);
      }
    });

  // 受理失败的 Host 队列请求按同一 requestId/原文显式重试；submit 端按请求标识幂等，不新建消息。
  const retryAdmission = () =>
    action.run(async () => {
      const bot = activeBot;
      const entry = activeChatScope ? pendingByBot.current.get(activeChatScope) : undefined;
      if (!bot || bot.hostKind !== 'local' || !entry?.pending.requestId || entry.pending.botKey !== bot.key) return;
      const { requestId, text, scopeKey, attachments, delivery } = entry.pending;
      const stillOwned = () => pendingByBot.current.get(scopeKey)?.pending.requestId === requestId;
      if (!stillOwned()) return;
      if (!centerConn.ready || centerConn.status?.state === 'disconnected') {
        setOfflineNotice({ botKey: bot.key, text: t('中心离线，草稿已保留。', 'Center offline; draft retained.') });
        return;
      }
      const snap = await ensureLocalHostRunning();
      if (!snap || snap.phase !== 'running' || !stillOwned()) return;
      try {
        const result = await BotHost.call({
          method: 'submit',
          params: {
            botId: bot.botId,
            requestId,
            text,
            ...(attachments?.length ? { attachments } : {}),
            ...(delivery ? { delivery } : {}),
          },
        });
        const receipt = result.result as HostSubmission & TurnAdmissionCarrier;
        if (!stillOwned()) return;
        updatePending({ pending: { ...entry.pending, phase: 'accepted', admission: receipt.admission ?? null }, receipt });
      } catch (error) {
        if (!stillOwned()) return;
        if ((error as { outcome?: string })?.outcome === 'not-sent') removePending(scopeKey, requestId);
        else updatePending({ pending: { ...entry.pending, phase: 'recovering' } });
        if (currentChatScope.current === scopeKey) throw error;
      }
    });

  // remote Bot 的同 ID 准入重试：直接 remote submit（同 requestId/原文），Host 端幂等受理，
  // 不走本地 pending_send——accepted 的 outbox 记录会被 store 短路而达不到 Host。
  const retryRemoteAdmission = () =>
    action.run(async () => {
      const bot = activeBot;
      const entry = activeChatScope ? pendingByBot.current.get(activeChatScope) : undefined;
      if (!bot || bot.hostKind !== 'remote' || !bot.remoteIdentity || !remoteClientRef.current || !entry?.pending.requestId || entry.pending.botKey !== bot.key) return;
      const { requestId, text, scopeKey, attachments, delivery } = entry.pending;
      const stillOwned = () => pendingByBot.current.get(scopeKey)?.pending.requestId === requestId;
      if (!stillOwned()) return;
      if (!remoteConnected || bot.online === false) {
        setOfflineNotice({ botKey: bot.key, text: t('目标离线，草稿已保留。', 'Target offline; draft retained.') });
        return;
      }
      try {
        const result = await remoteClientRef.current.api.call(bot.remoteIdentity, 'submit', {
          botId: bot.botId,
          requestId,
          text,
          ...(attachments?.length ? { attachments } : {}),
          ...(delivery ? { delivery } : {}),
        });
        const receipt = result as HostSubmission & TurnAdmissionCarrier;
        if (!stillOwned()) return;
        updatePending({ pending: { ...entry.pending, phase: 'accepted', admission: receipt?.admission ?? null }, receipt });
      } catch (error) {
        if (!stillOwned()) return;
        updatePending({ pending: { ...entry.pending, phase: 'recovering' } });
        if (currentChatScope.current === scopeKey) throw error;
      }
    });

  const saveAvatar = async (bot: { deviceId: string; botId: string }, value: GrokAvatarPreset | null) => {
    const api = await ensureRemoteApi();
    if (!api) throw new Error(t('请先连接中心，再保存头像', 'Connect to the center before saving an avatar'));
    await saveCentralBotAvatar(api, bot, value);
    setAvatarVersion(v => v + 1);
  };

  // Save in Edit Bot / Create Bot (15847.jpg "完成")
  const handleSaveBotEdit = (scope: 'all' | 'profile' | 'cwd' = 'all') => {
    if (action.busy || editSaveInFlight.current) return;
    editSaveInFlight.current = true;
    const draftOwner = profileEditKeyRef.current;
    return action.run(async () => {
      const roleName = editName.trim();
      if (scope !== 'cwd' && !roleName) return;

      if (editMode === 'create') {
        const targetHost = mustCreatePrimaryBot ? 'local' : editTargetHost;
        const shouldMakePrimary = editMakePrimary || mustCreatePrimaryBot;
        if (targetHost !== 'local' && (!remoteConnected || !remoteIdentity || !remoteClientRef.current || !remoteDevices.some(device => device.deviceId === targetHost && device.online))) throw new Error(t('所选设备不可用，未创建 Bot', 'Selected device unavailable; bot was not created'));
        if (createAttempt) throw new Error(t('创建回执未确认，请在待发送中按原 ID 对账', 'Creation unconfirmed; reconcile the original ID in Pending'));
        if (targetHost === 'local') {
          const snap = await ensureLocalHostRunning();
          if (!snap || snap.phase !== 'running') throw new Error(t('正在初始化运行环境，请稍后再试', 'Initializing runtime, please try again shortly'));
        }
        const requestId = uuid();
        setCreateAttempt({ requestId, target: targetHost, ...(targetHost !== 'local' ? { profileId: remoteIdentity?.profileId } : {}) });

        if (targetHost === 'local') {
          const snap = await ensureLocalHostRunning();
          if (!snap || snap.phase !== 'running') {
            throw new Error(t('正在初始化运行环境，请稍后再试', 'Initializing runtime, please try again shortly'));
          }
          const env = await BotHost.call({
            method: 'createBot',
            params: {
              requestId,
              role: roleName,
              description: editSubtitle.trim(),
              ...(editCwd.trim() ? { cwd: editCwd.trim() } : {}),
              modelRef: null,
              ...(shouldMakePrimary ? { makePrimary: true } : {}),
            },
          }).catch(error => { if (error?.outcome === 'not-sent') setCreateAttempt(null); throw error; });
          setCreateAttempt(null);
          const created = env.result as HostBot;
          const key = `local:local:${created.botId}`;
          saveBotAvatarConfig(botAvatarKey(created), editAvatarPreset);
          setAvatarVersion(v => v + 1);
          updateBotMeta(key, {
            customName: roleName,
            subtitle: editSubtitle.trim(),
            lastText: '',
            updatedAt: Date.now(),
            unread: false,
          });
          if (soulDraft.trim()) {
            try {
              const soulEnv = await BotHost.call({ method: 'getBotSoul', params: { botId: created.botId } });
              const s = parseBotSoul(soulEnv.result);
              if (s) {
                await BotHost.call({
                  method: 'setBotSoul',
                  params: { botId: created.botId, input: { expectedRevision: s.revision, text: soulDraft } },
                });
              }
            } catch {
              // Ignore optional soul init failure
            }
          }
          let assignedModelRef = created.modelRef;
          if (editModelRef.trim() && remoteConnected && remoteIdentity && remoteClientRef.current) {
            try {
              const api = remoteClientRef.current.api;
              const targetDeviceId = created.deviceId || localHost?.deviceId;
              if (targetDeviceId) {
                const targetIdentity = api.identityForTarget(targetDeviceId);
                const cfg = await api.broker(targetIdentity, 'center_bot_model_get', {
                  deviceId: targetDeviceId,
                  botId: created.botId,
                });
                await api.broker(targetIdentity, 'center_bot_model_set', {
                  deviceId: targetDeviceId,
                  botId: created.botId,
                  expectedRevision: cfg.revision,
                  value: { ...cfg.overrides, modelRef: editModelRef.trim() },
                });
                assignedModelRef = editModelRef.trim();
                void syncRemoteBots();
              }
            } catch {
              // Bot creation succeeded; keep going if optional post-create model assignment fails
            }
          }
          await syncLocalBots(snap);
          openBotChat({
            key,
            deviceId: created.deviceId,
            botId: created.botId,
            role: roleName,
            cwd: created.cwd,
            modelRef: assignedModelRef,
            createdAt: created.createdAt,
            isPrimary: created.isPrimary ?? shouldMakePrimary,
            hostKind: 'local',
            hostId: 'local',
            hostLabel: t('本机', 'Local'),
          });
        } else if (remoteIdentity && remoteClientRef.current) {
          const api = remoteClientRef.current.api;
          const targetIdentity = api.identityForTarget(targetHost);
          const created = (await api.mutateIntent(targetIdentity, 'createBot', {
            requestId,
            role: roleName,
            description: editSubtitle.trim(),
            ...(editCwd.trim() ? { cwd: editCwd.trim() } : {}),
            modelRef: null,
            ...(shouldMakePrimary ? { makePrimary: true } : {}),
          }).catch(error => { if (error?.outcome === 'not-sent') setCreateAttempt(null); throw error; })) as unknown as HostBot;
          setCreateAttempt(null);
          const key = `remote:${remoteIdentity.profileId}:${targetHost}:${created.botId}`;
          saveBotAvatarConfig(botAvatarKey({ deviceId: targetHost, botId: created.botId }), editAvatarPreset);
          setAvatarVersion(v => v + 1);
          updateBotMeta(key, {
            customName: roleName,
            subtitle: editSubtitle.trim(),
            lastText: '',
            updatedAt: Date.now(),
            unread: false,
          });
          if (editModelRef.trim()) {
            try {
              const cfg = await api.broker(targetIdentity, 'center_bot_model_get', {
                deviceId: targetHost,
                botId: created.botId,
              });
              await api.broker(targetIdentity, 'center_bot_model_set', {
                deviceId: targetHost,
                botId: created.botId,
                expectedRevision: cfg.revision,
                value: { ...cfg.overrides, modelRef: editModelRef.trim() },
              });
            } catch {
              // Bot creation succeeded; keep going if optional post-create model assignment fails
            }
          }
          await syncRemoteBots();
          nav.resetTo({ screen: 'hub' });
        }
      } else if (activeBot) {
        const trimmedCwd = editCwd.trim();
        const cwdChanged = scope !== 'profile' && trimmedCwd !== (scope === 'cwd' ? editCwdBaseline : activeBot.cwd ?? '');
        const profileChanged = scope !== 'cwd' && (roleName !== activeBot.role || editSubtitle.trim() !== (activeBot.description ?? ''));
        if (scope !== 'all') setEditSaveErrors(errors => ({ ...errors, [scope]: '' }));
        if (scope === 'cwd') setEditCwdSaved(false);
        const saveCwd = async () => {
          if (!cwdChanged) return;
          if (editCwdRevision === null) {
            throw new Error(t('工作目录修订尚未读取，请重新读取后再保存', 'Working directory revision not loaded; reload before saving'));
          }
          const fetchId = editCwdFetchRef.current;
          const api = await ensureRemoteApi();
          if (profileEditKeyRef.current !== draftOwner || editCwdFetchRef.current !== fetchId) return;
          const identity = activeBot.hostKind === 'local' ? api?.identity : activeBot.remoteIdentity;
          const broker = activeBot.hostKind === 'local' ? api : remoteClientRef.current?.api;
          if (!broker || !identity) {
            throw new Error(t('请先连接中心，再修改工作目录', 'Connect to the center before changing the working directory'));
          }
          try {
            const config = await broker.broker(identity, 'center_bot_cwd_set', {
              deviceId: activeBot.deviceId, botId: activeBot.botId,
              expectedRevision: editCwdRevision, value: trimmedCwd,
            });
            if (profileEditKeyRef.current !== draftOwner || editCwdFetchRef.current !== fetchId) return;
            setEditCwdRevision(config.revision);
            editCwdDirtyRef.current = false;
            setEditCwd(config.value ?? trimmedCwd);
            setEditCwdBaseline(config.value ?? trimmedCwd);
            setEditCwdError('');
            if (scope === 'cwd') setEditCwdSaved(true);
          } catch (error) {
            const code = (error as { code?: string })?.code;
            if (editCwdFetchRef.current === fetchId && (code === 'REVISION_CONFLICT' || code === 'REQUEST_CONFLICT')) {
              setEditCwdRevision(null);
              setEditCwdError(t('工作目录已被其他修改占用，请重新读取后再保存', 'Working directory was changed elsewhere; reload and save again'));
            }
            throw error;
          }
        };
        try {
          if (scope !== 'profile' && !trimmedCwd) {
            throw new Error(t('工作目录不能为空', 'Working directory cannot be empty'));
          }
          if (activeBot.hostKind === 'local') {
            if (profileChanged) await BotHost.call({ method: 'updateBotProfile', params: { botId: activeBot.botId, name: roleName, description: editSubtitle.trim() } });
            await saveCwd();
            await syncLocalBots();
          } else if (activeBot.remoteIdentity && remoteClientRef.current) {
            if (profileChanged) await remoteClientRef.current.api.call(activeBot.remoteIdentity, 'updateBotProfile', { botId: activeBot.botId, name: roleName, description: editSubtitle.trim() });
            await saveCwd();
            await syncRemoteBots();
          } else throw new Error(t('无法连接目标节点', 'Target host unavailable'));
          if (scope === 'all') await saveAvatar(activeBot, editAvatarPreset);
          if (scope !== 'cwd') updateBotMeta(activeBot.key, { customName: roleName, subtitle: editSubtitle.trim() });
        } catch (error) {
          if (scope === 'all') throw error;
          const code = (error as { code?: string })?.code;
          const cwdConflict = scope === 'cwd' && (code === 'REVISION_CONFLICT' || code === 'REQUEST_CONFLICT');
          if (profileEditKeyRef.current === draftOwner && !cwdConflict) {
            setEditSaveErrors(errors => ({ ...errors, [scope]: errorText(error) }));
          }
        }
      }
    }).finally(() => {
      editSaveInFlight.current = false;
    });
  };

  const handleSetPrimaryBot = (bot: UnifiedBotItem) =>
    action.run(async () => {
      setChatTopMenuOpen(false);
      if (bot.archivedAt) {
        throw new Error(t('已归档的 Bot 不能直接设为主 Bot，请先恢复', 'Archived bot cannot be set as primary. Unarchive it first.'));
      }
      if (bot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') throw new Error(t('本机服务未运行', 'Local host not running'));
        await BotHost.call({ method: 'setPrimaryBot', params: { botId: bot.botId } });
        await syncLocalBots(snap);
      } else if (bot.remoteIdentity && remoteClientRef.current) {
        if (!remoteConnected || bot.online === false) {
          throw new Error(t('目标设备离线，已拒绝修改', 'Target device is offline; operation rejected'));
        }
        await remoteClientRef.current.api.call(bot.remoteIdentity, 'setPrimaryBot', { botId: bot.botId });
        await syncRemoteBots();
      } else {
        throw new Error(t('无法连接目标节点', 'Target host unavailable'));
      }
      if (bot.hostKind === 'local') {
        chatPins.removePin(botPinKey(bot));
      }
    });

  const requestArchiveBot = (bot: UnifiedBotItem) => {
    setHubContextMenu(null);
    setChatTopMenuOpen(false);
    if (bot.isPrimary) {
      action.setError(t('主 Bot 受保护，请先将其他 Bot 设为主 Bot 后再归档', 'Primary bot is protected. Switch primary bot before archiving.'));
      return;
    }
    setBotConfirmModal({ kind: 'archive', bot });
  };

  const handleArchiveBot = (bot: UnifiedBotItem) =>
    action.run(async () => {
      setChatTopMenuOpen(false);
      if (bot.isPrimary) {
        throw new Error(t('主 Bot 受保护，请先将其他 Bot 设为主 Bot 后再归档', 'Primary bot is protected. Switch primary bot before archiving.'));
      }
      if (bot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') throw new Error(t('本机服务未运行', 'Local host not running'));
        await BotHost.call({ method: 'archiveBot', params: { botId: bot.botId } });
        await syncLocalBots(snap);
      } else if (bot.remoteIdentity && remoteClientRef.current) {
        if (!remoteConnected || bot.online === false) {
          throw new Error(t('目标设备离线，已拒绝修改', 'Target device is offline; operation rejected'));
        }
        await remoteClientRef.current.api.call(bot.remoteIdentity, 'archiveBot', { botId: bot.botId });
        await syncRemoteBots();
      } else {
        throw new Error(t('无法连接目标节点', 'Target host unavailable'));
      }
      chatPins.removePin(botPinKey(bot));
      setBotConfirmModal(null);
      if (screen !== 'hub') {
        nav.resetTo({ screen: 'hub' });
      }
    });

  const handleUnarchiveBot = (bot: UnifiedBotItem) =>
    action.run(async () => {
      setHubContextMenu(null);
      setChatTopMenuOpen(false);
      if (bot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') throw new Error(t('本机服务未运行', 'Local host not running'));
        await BotHost.call({ method: 'unarchiveBot', params: { botId: bot.botId } });
        await syncLocalBots(snap);
      } else if (bot.remoteIdentity && remoteClientRef.current) {
        if (!remoteConnected || bot.online === false) {
          throw new Error(t('目标设备离线，已拒绝修改', 'Target device is offline; operation rejected'));
        }
        await remoteClientRef.current.api.call(bot.remoteIdentity, 'unarchiveBot', { botId: bot.botId });
        await syncRemoteBots();
      } else {
        throw new Error(t('无法连接目标节点', 'Target host unavailable'));
      }
    });

  const requestDeleteBot = (bot: UnifiedBotItem) => {
    setHubContextMenu(null);
    setChatTopMenuOpen(false);
    if (bot.isPrimary) {
      action.setError(t('主 Bot 受保护，不能直接删除。请先将其他 Bot 设为主 Bot。', 'Primary bot is protected. Switch primary bot before deleting.'));
      return;
    }
    setBotConfirmModal({ kind: 'delete', bot });
  };

  const handleDeleteBot = (bot: UnifiedBotItem) =>
    action.run(async () => {
      setChatTopMenuOpen(false);
      if (bot.isPrimary) {
        throw new Error(t('主 Bot 受保护，不能直接删除。请先将其他 Bot 设为主 Bot。', 'Primary bot is protected. Switch primary bot before deleting.'));
      }
      if (deletingBots.current.has(bot.key)) return;
      deletingBots.current.add(bot.key);
      if (activeBotKey === bot.key) {
        chatLoadGeneration.current += 1;
        chatHistoryEpoch.current += 1;
        profileLoadGeneration.current += 1;
        cancelActiveObservation();
      }
      let deleted = false;
      try {
        if (bot.hostKind === 'local') {
          const snap = await ensureLocalHostRunning();
          if (!snap || snap.phase !== 'running') throw new Error(t('本机服务未运行', 'Local host not running'));
          await deleteBotAndVerify(
            () => BotHost.call({ method: 'deleteBot', params: { botId: bot.botId } }),
            () => BotHost.call({ method: 'getBot', params: { botId: bot.botId } }),
          );
          deleted = true;
          localBotsScopeRef.current = { ...localBotsScopeRef.current };
          await syncLocalBots(snap).catch(() => {});
          if (localBotsScopeRef.current.center === activeCenter) {
            setLocalBots(previous => previous.filter(item => item.botId !== bot.botId));
          }
        } else if (bot.remoteIdentity && remoteClientRef.current) {
          if (!remoteConnected || bot.online === false) {
            throw new Error(t('目标设备离线，已拒绝修改', 'Target device is offline; operation rejected'));
          }
          const api = remoteClientRef.current.api;
          const identity = bot.remoteIdentity;
          await deleteBotAndVerify(
            () => api.call(identity, 'deleteBot', { botId: bot.botId }),
            () => api.call(identity, 'getBot', { botId: bot.botId }),
          );
          deleted = true;
          directoryGeneration.current += 1;
          await syncRemoteBots().catch(() => {});
          if (api.identity?.profileId === identity.profileId) {
            setRemoteBots(previous => {
              const next = previous.filter(item => item.deviceId !== bot.deviceId || item.botId !== bot.botId);
              writeCachedRemoteBots(next);
              return next;
            });
          }
        } else {
          throw new Error(t('无法连接目标节点', 'Target host unavailable'));
        }
        const deletedScopeKey = scopeForBot(bot);
        if (deletedScopeKey) chatHistoryCacheRef.current.delete(deletedScopeKey);
        chatPins.removePin(botPinKey(bot));
        setBotConfirmModal(null);
        if (activeBotKey === bot.key) {
          cancelActiveObservation();
          setScopedChatLive(undefined);
          setActiveBotKey(null);
        }
        const returnToArchived = nav.stackRef.current.some(entry => entry.screen === 'archived-bots');
        if (returnToArchived) {
          nav.push({ screen: 'archived-bots' });
        } else {
          nav.resetTo({ screen: 'hub' });
        }
      } finally {
        if (!deleted) {
          deletingBots.current.delete(bot.key);
          setChatResumeEpoch(value => value + 1);
        }
      }
    });

  // 群行直接解散删除：走 authority resolved members API，先读最新 scope 冻结 requestId / expectedRevision，
  // 二次确认后 mutateIntent('deleteScope')；未确认保留原请求可按原 ID 确认，绝不自动以新 ID 重发。
  const roomDeleteFetchSeqRef = useRef(0);
  const loadLatestRoomForDelete = useCallback(
    async (room: ScopeConversation) => {
      const scopeId = room.scope.scope.scopeId;
      const fetchSeq = ++roomDeleteFetchSeqRef.current;
      setRoomDeleteModal({
        room,
        loadingLatest: true,
        submitting: false,
        attempt: null,
        error: '',
        conflictNeedReload: false,
      });
      const authorityDeviceId = room.scope.authorityDeviceId;
      if (!authorityDeviceId) {
        setRoomDeleteModal({
          room,
          loadingLatest: false,
          submitting: false,
          attempt: null,
          error: t('该群聊缺少权威节点信息，无法解散并删除群聊。', 'Missing authority node for this group; cannot disband.'),
          conflictNeedReload: false,
        });
        return;
      }
      const wApi = resolveRoomApi(room.scope, 'members');
      const wIdentity = wApi?.identity;
      if (!wApi || !wIdentity || !wApi.transportConnected) {
        setRoomDeleteModal({
          room,
          loadingLatest: false,
          submitting: false,
          attempt: null,
          error: t('群聊权威节点当前未连接或离线，请恢复连接后再读取最新状态。', 'Authority node is offline or disconnected; reconnect and retry.'),
          conflictNeedReload: true,
        });
        return;
      }
      const sess = `${wIdentity.profileId}|${wIdentity.kind}|${wIdentity.generation}|${wIdentity.targetDeviceId}`;
      try {
        const latest = await wApi.call(wIdentity, 'getScopeState', { scopeId });
        if (roomDeleteFetchSeqRef.current !== fetchSeq) return;
        if ((latest.scope as { deletedAt?: string }).deletedAt) {
          unconfirmedRoomDeletesRef.current.delete(scopeId);
          chatPins.removePin(roomPinKey(scopeId));
          markRoomConversationDeletedRef.current(scopeId);
          if (scopeConversationTarget?.scope.scope.scopeId === scopeId) {
            setRoomSettingsOpen(false);
            setScopeConversationTarget(null);
            if (!nav.pop()) nav.resetTo({ screen: 'hub' });
          }
          setRoomDeleteModal(null);
          refreshRoomConversationsRef.current();
          return;
        }
        const latestTitle =
          (latest.scope as { title?: string }).title?.trim() ||
          conversationTitle(latest.scope, knownBots) ||
          room.title;
        const attempt: RoomDeleteAttempt = {
          scopeId,
          title: latestTitle,
          authorityDeviceId: latest.authorityDeviceId ?? authorityDeviceId,
          requestId: uuid(),
          expectedRevision: latest.scope.revision,
          sessionKey: sess,
          unconfirmed: false,
        };
        setRoomDeleteModal({
          room: { ...room, scope: latest, title: latestTitle },
          loadingLatest: false,
          submitting: false,
          attempt,
          error: '',
          conflictNeedReload: false,
        });
      } catch (err) {
        if (roomDeleteFetchSeqRef.current !== fetchSeq) return;
        const errCode = (err as { code?: string })?.code;
        if (errCode === 'SCOPE_DELETED') {
          unconfirmedRoomDeletesRef.current.delete(scopeId);
          chatPins.removePin(roomPinKey(scopeId));
          markRoomConversationDeletedRef.current(scopeId);
          if (scopeConversationTarget?.scope.scope.scopeId === scopeId) {
            setRoomSettingsOpen(false);
            setScopeConversationTarget(null);
            if (!nav.pop()) nav.resetTo({ screen: 'hub' });
          }
          setRoomDeleteModal(null);
          refreshRoomConversationsRef.current();
          return;
        }
        setRoomDeleteModal({
          room,
          loadingLatest: false,
          submitting: false,
          attempt: null,
          error: t('读取最新群状态失败：', 'Failed to read latest group state: ') + errorText(err),
          conflictNeedReload: true,
        });
      }
    },
    [resolveRoomApi, chatPins, roomPinKey, knownBots, scopeConversationTarget, t],
  );

  const openRoomDeleteConfirm = useCallback(
    (room: ScopeConversation) => {
      setHubContextMenu(null);
      const scopeId = room.scope.scope.scopeId;
      const existing = unconfirmedRoomDeletesRef.current.get(scopeId);
      if (existing) {
        setRoomDeleteModal({
          room,
          loadingLatest: false,
          submitting: false,
          attempt: existing,
          error: t('上次解散请求结果未确认，已保留原请求 ID，不会自动以新 ID 重发；请按原 ID 确认。',
            'Previous disband request is unconfirmed. Original request ID is retained; confirm by original ID.'),
          conflictNeedReload: false,
        });
        return;
      }
      void loadLatestRoomForDelete(room);
    },
    [loadLatestRoomForDelete, t],
  );

  const executeRoomDelete = useCallback(async () => {
    const currentModal = roomDeleteModal;
    const attempt = currentModal?.attempt;
    if (!currentModal || !attempt || currentModal.submitting || currentModal.loadingLatest) return;
    const wApi = resolveRoomApi(currentModal.room.scope, 'members');
    const wIdentity = wApi?.identity;
    if (!wApi || !wIdentity || !wApi.transportConnected) {
      setRoomDeleteModal(prev =>
        prev
          ? {
              ...prev,
              error: t('群聊权威节点当前未连接或离线，请恢复连接后再确认。', 'Authority node is offline or disconnected; reconnect before confirming.'),
            }
          : null,
      );
      return;
    }
    setRoomDeleteModal(prev => (prev ? { ...prev, submitting: true, error: '' } : null));
    try {
      if (attempt.unconfirmed) {
        try {
          const check = await wApi.call(wIdentity, 'getScopeState', { scopeId: attempt.scopeId });
          if ((check.scope as { deletedAt?: string }).deletedAt) {
            unconfirmedRoomDeletesRef.current.delete(attempt.scopeId);
            chatPins.removePin(roomPinKey(attempt.scopeId));
            markRoomConversationDeletedRef.current(attempt.scopeId);
            if (scopeConversationTarget?.scope.scope.scopeId === attempt.scopeId) {
              setRoomSettingsOpen(false);
              setScopeConversationTarget(null);
              if (!nav.pop()) nav.resetTo({ screen: 'hub' });
            }
            setRoomDeleteModal(null);
            refreshRoomConversationsRef.current();
            return;
          }
        } catch (checkErr) {
          const checkCode = (checkErr as { code?: string })?.code;
          if (checkCode === 'NOT_FOUND' || checkCode === 'SCOPE_DELETED') {
            unconfirmedRoomDeletesRef.current.delete(attempt.scopeId);
            chatPins.removePin(roomPinKey(attempt.scopeId));
            markRoomConversationDeletedRef.current(attempt.scopeId);
            if (scopeConversationTarget?.scope.scope.scopeId === attempt.scopeId) {
              setRoomSettingsOpen(false);
              setScopeConversationTarget(null);
              if (!nav.pop()) nav.resetTo({ screen: 'hub' });
            }
            setRoomDeleteModal(null);
            refreshRoomConversationsRef.current();
            return;
          }
        }
      }
      await (wApi as unknown as {
        mutateIntent: (id: DesktopIdentity, method: string, params: Record<string, unknown>) => Promise<unknown>;
      }).mutateIntent(wIdentity, 'deleteScope', {
        scopeId: attempt.scopeId,
        input: {
          requestId: attempt.requestId,
          expectedRevision: attempt.expectedRevision,
        },
      });
      unconfirmedRoomDeletesRef.current.delete(attempt.scopeId);
      chatPins.removePin(roomPinKey(attempt.scopeId));
      markRoomConversationDeletedRef.current(attempt.scopeId);
      if (scopeConversationTarget?.scope.scope.scopeId === attempt.scopeId) {
        setRoomSettingsOpen(false);
        setScopeConversationTarget(null);
        if (!nav.pop()) nav.resetTo({ screen: 'hub' });
      }
      setRoomDeleteModal(null);
      refreshRoomConversationsRef.current();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const outcome = (err as { outcome?: string })?.outcome;
      if (code === 'REVISION_CONFLICT' || code === 'REQUEST_CONFLICT') {
        unconfirmedRoomDeletesRef.current.delete(attempt.scopeId);
        setRoomDeleteModal(prev =>
          prev
            ? {
                ...prev,
                submitting: false,
                attempt: null,
                conflictNeedReload: true,
                error: t('群聊状态已被更新，请重新读取最新群信息后再确认解散。', 'Group state changed elsewhere; reload latest group state before confirming.'),
              }
            : null,
        );
        return;
      }
      if (outcome === 'not-sent') {
        setRoomDeleteModal(prev =>
          prev ? { ...prev, submitting: false, error: errorText(err) } : null,
        );
        return;
      }
      const frozenUnconfirmed: RoomDeleteAttempt = { ...attempt, unconfirmed: true };
      unconfirmedRoomDeletesRef.current.set(attempt.scopeId, frozenUnconfirmed);
      setRoomDeleteModal(prev =>
        prev
          ? {
              ...prev,
              submitting: false,
              attempt: frozenUnconfirmed,
              error: t(`解散结果未确认（${errorText(err)}）。已冻结原请求 ID，可按原 ID 确认，不会使用新 ID 自动重发。`,
                `Disband unconfirmed (${errorText(err)}). Original request ID frozen; confirm by original ID without auto-resending.`),
            }
          : null,
      );
    }
  }, [roomDeleteModal, resolveRoomApi, chatPins, roomPinKey, scopeConversationTarget, nav.pop, nav.resetTo, t]);

  const refreshDirectoryAfterConfig = useCallback(() => {
    void syncLocalBots();
    void syncRemoteBots();
  }, [syncLocalBots, syncRemoteBots]);

  const closeModelTarget = useCallback(() => {
    setModelTarget(null);
    refreshDirectoryAfterConfig();
  }, [refreshDirectoryAfterConfig]);

  const openModelPickerSheet = (tab: 'model' | 'capabilities' = 'model') => {
    if (!activeBot || !remoteIdentity || !remoteConnected || !remoteClientRef.current) return;
    const deviceId = activeBot.hostKind === 'local' ? localHost?.deviceId : activeBot.hostId;
    if (!deviceId) return;
    const api = remoteClientRef.current.api;
    setModelTarget({ botKey: activeBot.key, botId: activeBot.botId, center: activeCenter, identity: api.identityForTarget(deviceId), api, tab });
  };

  useEffect(() => {
    setModelTarget(null);
  }, [activeBotKey, activeCenter, remoteIdentity?.generation, remoteConnected, screen, localHost?.deviceId]);

  // Save Bot Soul (CAS)
  const handleSaveSoul = () =>
    action.run(async () => {
      if (editMode === 'create' && screen === 'bot-soul') {
        setEditInitialSoul(soulDraft);
        setSoulDirty(false);
        if (!nav.pop()) nav.resetTo({ screen: 'hub' });
        return;
      }
      if (!activeBot) return;
      if (soulBytes(soulDraft) > SOUL_MAX_BYTES) {
        throw new Error(t('灵魂文档超出 64 KiB 上限', 'SOUL.md exceeds 64 KiB limit'));
      }
      if (activeBot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') return;
        const targetBotId = activeBot.botId;
        const currentSoul =
          botSoul && botSoul.botId === targetBotId
            ? botSoul
            : parseBotSoul((await BotHost.call({ method: 'getBotSoul', params: { botId: targetBotId } })).result);
        if (!currentSoul) return;
        const savedEnv = await BotHost.call({
          method: 'setBotSoul',
          params: {
            botId: targetBotId,
            input: { expectedRevision: currentSoul.revision, text: soulDraft },
          },
        });
        const saved = parseBotSoul(savedEnv.result);
        if (saved) {
          setBotSoul(saved);
          setSoulDraft(saved.text);
          setSoulDirty(false);
        }
      } else if (activeBot.hostKind === 'remote' && activeBot.remoteIdentity && remoteClientRef.current && botSoul) {
        const res = await remoteClientRef.current.api.call(activeBot.remoteIdentity, 'setBotSoul', {
          botId: activeBot.botId,
          input: { expectedRevision: botSoul.revision, text: soulDraft },
        });
        const saved = parseBotSoul(res);
        if (saved) {
          setBotSoul(saved);
          setSoulDraft(saved.text);
          setSoulDirty(false);
        }
      }
      if (!nav.pop()) nav.resetTo({ screen: 'hub' });
    });


  // Resolve targetBotId and primaryConversationId for Local Bot Schedule operations
  const resolveLocalBotScheduleOwner = async (): Promise<{
    botId: string;
    conversationId: string;
    botKey: string;
  } | null> => {
    if (!activeBot || activeBot.hostKind !== 'local') return null;
    const snap = await ensureLocalHostRunning();
    if (!snap || snap.phase !== 'running') {
      throw new Error(t('正在启动本机运行环境，请稍后重试', 'Starting local runtime, please try again'));
    }
    const targetBotId = activeBot.botId;
    const targetKey = activeBot.key;
    const latestBots = await syncLocalBots(snap);
    const matched = latestBots.find(b => b.botId === targetBotId);
    const convId = activeBot.primaryConversationId || matched?.primaryConversationId || '';
    if (!convId) {
      throw new Error(t('未找到该 Bot 的主会话标识', 'Primary conversation ID not found for this Bot'));
    }
    return { botId: targetBotId, conversationId: convId, botKey: targetKey };
  };

  const openScheduleCreate = () => {
    setScheduleCustomWeekdays(false);
    setScheduleDraft({
      title: '',
      prompt: '',
      repeat: 'daily',
      time: '08:00',
      weekdays: [1, 2, 3, 4, 5],
      monthDay: 1,
      alarmMode: 'alarmClock',
      vibrate: true,
      deleteAfterRun: false,
    });
    setScheduleEditing('new');
  };

  const openScheduleEdit = (task: BotScheduleTask) => {
    const days =
      task.weekdays && task.weekdays.length > 0
        ? task.weekdays.slice().sort((a, b) => a - b)
        : [task.weekday ?? 1];
    const isCustomWeekly =
      task.repeat === 'weekly' && days.join(',') !== '1,2,3,4,5' && days.join(',') !== '6,7';
    setScheduleCustomWeekdays(isCustomWeekly);
    setScheduleDraft({
      id: task.id,
      revision: task.revision,
      title: task.title || '',
      prompt: task.prompt ?? '',
      repeat: task.repeat,
      time: task.time || '08:00',
      date: task.date,
      weekdays: days,
      monthDay: task.monthDay ?? 1,
      alarmMode: task.alarmMode === 'exact' ? 'exact' : 'alarmClock',
      vibrate: Boolean(task.vibrate),
      deleteAfterRun: Boolean(task.deleteAfterRun),
    });
    setScheduleEditing('edit');
  };

  const executeActiveBotSchedule = async (input: Record<string, unknown>) => {
    if (!activeBot) return;
    if (activeBot.hostKind === 'local') {
      const owner = await resolveLocalBotScheduleOwner();
      if (!owner) return;
      await BotHost.call({
        method: 'uiScheduleTask',
        params: {
          botId: owner.botId,
          conversationId: owner.conversationId,
          input,
        },
      });
      await loadBotSchedules({
        ...activeBot,
        botId: owner.botId,
        key: owner.botKey,
        primaryConversationId: owner.conversationId,
      });
    } else if (activeBot.hostKind === 'remote') {
      if (!activeBot.remoteIdentity || !remoteClientRef.current || !remoteConnected || activeBot.online === false) {
        throw new Error(t('目标设备离线，已拒绝修改', 'Target device is offline; operation rejected'));
      }
      await remoteClientRef.current.api.call(activeBot.remoteIdentity, 'scheduleTask', {
        botId: activeBot.botId,
        input,
      });
      await loadBotSchedules(activeBot);
    }
  };

  const handleToggleSchedule = (task: BotScheduleTask, nextEnabled: boolean) =>
    action.run(async () => {
      await executeActiveBotSchedule({
        action: 'setEnabled',
        id: task.id,
        revision: task.revision,
        enabled: nextEnabled,
      });
    });

  const handleDeleteSchedule = (task: BotScheduleTask) =>
    action.run(async () => {
      await executeActiveBotSchedule({
        action: 'delete',
        id: task.id,
        revision: task.revision,
      });
      setScheduleDeleteTarget(null);
      setScheduleEditing(null);
    });

  const handleSaveSchedule = () =>
    action.run(async () => {
      const title = scheduleDraft.title.trim();
      const prompt = scheduleDraft.prompt.trim();
      if (!title || !prompt) {
        throw new Error(t('请填写任务名称与执行指令', 'Please enter task title and prompt instructions'));
      }
      if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(scheduleDraft.time)) {
        throw new Error(t('时间格式无效，请使用 HH:mm', 'Invalid time format (HH:mm)'));
      }
      if (scheduleDraft.repeat === 'weekly' && scheduleDraft.weekdays.length === 0) {
        throw new Error(t('请至少选择一个执行星期', 'Please select at least one weekday'));
      }

      const basePayload: Record<string, unknown> = {
        title,
        prompt,
        repeat: scheduleDraft.repeat,
        time: scheduleDraft.time,
        alarmMode: scheduleDraft.alarmMode,
        vibrate: scheduleDraft.vibrate,
        deleteAfterRun: scheduleDraft.deleteAfterRun,
      };
      if (scheduleDraft.repeat === 'weekly') {
        basePayload.weekdays = scheduleDraft.weekdays.slice().sort((a, b) => a - b);
      } else if (scheduleDraft.repeat === 'monthly') {
        basePayload.monthDay = Math.min(31, Math.max(1, Math.round(scheduleDraft.monthDay)));
      } else if (scheduleDraft.repeat === 'once' && scheduleDraft.date) {
        basePayload.date = scheduleDraft.date;
      }

      if (scheduleEditing === 'edit' && scheduleDraft.id && scheduleDraft.revision) {
        await executeActiveBotSchedule({
          action: 'update',
          id: scheduleDraft.id,
          revision: scheduleDraft.revision,
          ...basePayload,
          ...(scheduleDraft.repeat === 'once' && scheduleDraft.date === '' ? { date: null } : {}),
        });
      } else {
        await executeActiveBotSchedule({
          action: 'create',
          ...basePayload,
        });
      }
      setScheduleEditing(null);
    });

  const handleRequestExactAlarm = () =>
    action.run(async () => {
      await BotHost.call({
        method: 'uiScheduleTask',
        params: {
          botId: activeBot?.botId ?? '',
          conversationId: activeBot?.primaryConversationId ?? '',
          input: { action: 'requestExactAlarm' },
        },
      });
      if (activeBot) await loadBotSchedules(activeBot);
    });

  const scheduleTasks = botScheduleState.botKey === activeBot?.key ? botScheduleState.tasks : [];
  const scheduleError = botScheduleState.botKey === activeBot?.key ? botScheduleState.schedulingError : '';
  const scheduleOffline = activeBot?.hostKind === 'remote' && (!remoteConnected || activeBot.online === false);

  const currentClearedAfter = !activeBot
    ? 0
    : activeChatScope && clearedMap[activeChatScope] !== undefined
      ? clearedMap[activeChatScope]
      : (clearedMap[activeBot.key] ?? 0);
  const chatLive = chatLiveForBot(activeBot, activeChatScope);
  const effectiveChatLive = isStaleLiveState(chatLive, currentClearedAfter) ? undefined : chatLive;
  const submission = chatSubmissionRef.current;
  // 用户主动停止的 unanswered 回执（reason aborted/cancelled）是已停止结算，不是配置/模型故障：
  // 既不弹“未获得回答/检查配置”卡，也不让 WorkingSlot 按 error 结算；真实 model_error 等仍显示。
  const receiptUserCancelled =
    chatReceipt?.status === 'unanswered' &&
    typeof chatReceipt.reason === 'string' &&
    /abort|cancel/i.test(chatReceipt.reason);
  const submissionInCurrentEpoch = Boolean(submission && submission.afterEntryId >= currentClearedAfter);
  const submissionFailure = submission && submissionInCurrentEpoch && chatReceipt?.status === 'unanswered' && !receiptUserCancelled &&
    submission.botKey === activeBot?.key && chatReceipt.requestId === submission.requestId &&
    !parseHistoryEntries(chatHistory, currentClearedAfter).some(turn => turn.error && turn.entryId > submission.afterEntryId)
      ? chatReceipt.reason === 'model_error'
        ? t('模型生成失败，请重试或检查模型配置。', 'Model generation failed. Retry or check the model configuration.')
        : t('本次请求未获得回答，请重试。', 'No answer was generated for this request. Please retry.')
      : undefined;

  const recoveringChat = chatPending?.botKey === activeBot?.key && chatPending?.phase === 'recovering';
  const liveGenerationAttr = effectiveChatLive?.generation?.attribution;
  const liveGeneratingText = recoveringChat ? '' : effectiveChatLive?.generation?.text ?? '';
  // generation.blocks 与 displayGeneratingText 同一过滤口径：协作生成/恢复中不传入，
  // 避免协作文本经块投影漏进普通聊天（见 allChatTurns 的 liveGeneratingBlocks）。

  // 当前会话的按轮受理状态：live 已就绪时以 effectiveChatLive.turnAdmission 为权威（null 即已离开准入阶段，不回退过期回执）；
  // 仅在 live 尚未到达前才回退提交回执/持久化 pending 上的 admission。
  const liveTurnAdmission = effectiveChatLive?.turnAdmission ?? null;
  const pendingAdmission = chatPending && chatPending.botKey === activeBot?.key && chatPending.afterEntryId >= currentClearedAfter
    ? (chatPending.admission ?? (chatReceipt as TurnAdmissionCarrier | undefined)?.admission ?? null)
    : null;
  const chatTurnAdmission = effectiveChatLive !== undefined
    ? liveTurnAdmission
    : pendingAdmission;
  const admissionStatusText = chatTurnAdmission?.phase === 'failed'
    ? chatTurnAdmission.error?.code === 'MODEL_NO_VISION'
      ? t('当前模型不支持图片输入：请切换支持视觉的模型后重试，或恢复到输入框修改/移除图片后再发。',
          'Current model does not support image input. Switch to a vision-capable model and retry, or restore to the composer to edit or remove images.')
      : t('同步失败：' + (chatTurnAdmission.error?.message || chatTurnAdmission.error?.code || '') + '，消息已保留。',
          'Sync failed: ' + (chatTurnAdmission.error?.message || chatTurnAdmission.error?.code || '') + '; message retained.')
    : '';

  // 统一活动状态：新 Host 帧带 activity 则以它为准；旧 Host 缺省走 resolveBotActivity 的旧字段 fallback。
  // 未受理的发送中阶段不再伪装 queued；live 尚在连接时已受理但未失败的回执按 preparing 过渡。
  const rawBotActivity = resolveBotActivity(
    recoveringChat || (chatHostKind === 'remote' && !(chatRemoteConnected && activeBot?.online !== false))
      ? null
      : effectiveChatLive,
  );
  const isStoppingBot = Boolean(activeBot && stopping.has(activeBot.key));

  const sendingOptimistic = !recoveringChat && chatPending?.botKey === activeBot?.key && chatPending?.phase === 'sending';
  const sendingReceipt = Boolean(chatPending?.botKey === activeBot?.key && chatPending?.phase !== 'accepted');
  const acceptedPendingPreparing =
    !recoveringChat &&
    !isStoppingBot &&
    !isBotActivityBusy(rawBotActivity) &&
    effectiveChatLive === undefined &&
    chatPending?.botKey === activeBot?.key &&
    chatPending?.phase === 'accepted' &&
    chatTurnAdmission !== null &&
    chatTurnAdmission.phase !== 'failed' &&
    (chatReceipt?.status === undefined || chatReceipt.status === 'queued');
  // 本地停止在途时无条件显示 stopping（覆盖 Host 尚未更新的 running）；未受理发送中保持 Host 真实态，不误标 queued。
  const botActivity: BotActivity = isStoppingBot
    ? { ...rawBotActivity, phase: 'stopping' }
    : acceptedPendingPreparing
      ? {
          ...rawBotActivity,
          phase: 'preparing',
          source: chatTurnAdmission.source ?? 'primary',
          requestId: chatTurnAdmission.requestId,
        }
      : rawBotActivity;
  const isBotBusy = isBotActivityBusy(botActivity) || Boolean(sendingOptimistic);
  // Host activity.error（phase 'failed' 附带的有界诊断）是最具体的失败原因：
  // 直接展示 message/code 原文，不加「Host」字样或身份前缀；无此字段回落原回执提示。
  const activityFailure =
    botActivity.phase === 'failed' && botActivity.error
      ? botActivity.error.code === 'CONTEXT_LIMIT'
        ? t('上下文超过模型上限，请压缩对话或调整模型的上下文窗口后重试。', 'Context limit reached. Compact the conversation or adjust the model context window, then retry.')
        : botActivity.error.code === 'MODEL_NO_VISION'
          ? `${botActivity.error.code}: ${botActivity.error.message || 'model does not accept image input'}`
          : botActivity.error.message || botActivity.error.code
      : undefined;
  const failureNotice = activityFailure || submissionFailure;
  const isChatTargetOnline = Boolean(
    activeBot && (activeBot.hostKind !== 'remote' || (remoteConnected && activeBot.online !== false)),
  );
  const canStopBot = Boolean(
    activeBot && !activeBot.archivedAt && canStopBotActivity(botActivity) && isChatTargetOnline,
  );
  const activeEditing = editingTurn && activeBot && editingTurn.botKey === activeBot.key ? editingTurn : null;
  const effectiveLocalDraft = activeEditing ? activeEditing.text : chatDraft;
  const effectiveLocalAttachments = activeEditing ? activeEditing.attachments : chatDraftAttachments;

  // 严格遵守：Bot 忙碌时不允许编辑历史消息。一旦进入忙碌/停止/切走会话立即退出编辑态、收起气泡菜单并清理录音 UI。
  useEffect(() => {
    if (screen !== 'chat') {
      if (bubbleActionTurn) setBubbleActionTurn(null);
      setVoicePartialText('');
      setVoiceLevel(0);
    } else if (voiceCapturing && activeBot && voiceCapturing.botId !== activeBot.botId) {
      setVoicePartialText('');
      setVoiceLevel(0);
    }
    if (bubbleActionTurn) {
      const nextEditable =
        bubbleActionTurn.editable && !isBotBusy && !isStoppingBot && !sendingReceipt;
      const nextCanRetry =
        bubbleActionTurn.canRetry && chatTurnAdmission?.phase === 'failed';
      const hasActions = Boolean(
        activeBot && (bubbleActionTurn.turn.text.trim() || nextEditable || nextCanRetry),
      );
      if (!hasActions) {
        setBubbleActionTurn(null);
      } else if (nextEditable !== bubbleActionTurn.editable || nextCanRetry !== bubbleActionTurn.canRetry) {
        setBubbleActionTurn(prev => {
          if (!prev) return null;
          const editable = prev.editable && !isBotBusy && !isStoppingBot && !sendingReceipt;
          const canRetry = prev.canRetry && chatTurnAdmission?.phase === 'failed';
          if (!prev.turn.text.trim() && !editable && !canRetry) return null;
          return { ...prev, editable, canRetry };
        });
      }
    }
    if (!editingTurn || editSubmitting) return;
    if (
      screen !== 'chat' ||
      !activeBot ||
      editingTurn.botKey !== activeBot.key ||
      isBotBusy ||
      isStoppingBot ||
      sendingReceipt
    ) {
      setEditingTurn(null);
    }
  }, [bubbleActionTurn, voiceCapturing, editingTurn, editSubmitting, screen, activeBot, isBotBusy, isStoppingBot, sendingReceipt, chatTurnAdmission?.phase]);

  const canEditHistoryTurn = Boolean(
    activeBot &&
      !activeBot.archivedAt &&
      isChatTargetOnline &&
      (activeBot.hostKind === 'local' ? localHost?.phase === 'running' : remoteConnected) &&
      !isBotBusy &&
      !isStoppingBot &&
      !sendingReceipt &&
      !slashBusy &&
      !editSubmitting,
  );

  const localComposerAction = resolveComposerActionKind({
    phase: botActivity.phase,
    online: isChatTargetOnline,
    archived: Boolean(!activeBot || activeBot.archivedAt),
    isSending: Boolean(sendingOptimistic || sendingReceipt || editSubmitting),
    isStopping: isStoppingBot,
    pendingAdmissionWaiting: effectiveChatLive === undefined && chatTurnAdmission !== null && chatTurnAdmission.phase !== 'failed',
    hasDraft: Boolean(effectiveLocalDraft.trim()) || effectiveLocalAttachments.length > 0,
    canStop: canStopBot,
  });
  const isStoppingChat = localComposerAction === 'stopping';
  const isPreLlmChat = localComposerAction === 'loading';
  const isLlmRunningChat = localComposerAction === 'queue' || localComposerAction === 'stop';
  const showLocalComposerStop =
    !(sendingReceipt && !canStopBotActivity(rawBotActivity)) &&
    !editSubmitting &&
    shouldShowComposerStop({
      phase: botActivity.phase,
      online: isChatTargetOnline,
      archived: Boolean(!activeBot || activeBot.archivedAt),
      isStopping: isStoppingChat,
      canStop: canStopBot,
    });

  const mergeWithdrawnToLocalScope = useCallback(async (
    bot: UnifiedBotItem,
    scopeKey: string,
    withdrawn: readonly WithdrawnTurnItem[],
    mergeIntoDraft: boolean,
  ) => {
    if (!withdrawn.length) return;
    for (const w of withdrawn) {
      if (scopeKey) removePending(scopeKey, w.requestId);
    }
    if (!mergeIntoDraft || !scopeKey) return;
    const texts = withdrawn.map(w => extractEditableUserText(w.text));
    const attachmentIds = withdrawn.flatMap(w => w.attachments ?? []);
    const fetcher = attachmentIds.length > 0
      ? async (attachmentId: string) => {
          const env = await BotHost.call({
            method: 'getAttachment',
            params: { botId: bot.botId, attachmentId },
          });
          return env.result as ImageAttachmentData;
        }
      : null;
    const resolvedAtts = await resolveAttachmentMetasByIds(attachmentIds, fetcher);
    const baseDraft = currentChatScope.current === scopeKey ? (chatDraft || readChatDraft(scopeKey)) : readChatDraft(scopeKey);
    const baseAtts = currentChatScope.current === scopeKey && chatDraftAttachments.length > 0
      ? chatDraftAttachments
      : readChatDraftAttachments(scopeKey);
    const nextDraft = mergeWithdrawnIntoDraft(baseDraft, texts);
    const nextAtts = dedupeAttachmentMetas(baseAtts, resolvedAtts, IMAGE_MAX_COUNT);
    writeChatDraft(scopeKey, nextDraft);
    writeChatDraftAttachments(scopeKey, nextAtts);
    if (currentChatScope.current === scopeKey) {
      setChatDraft(nextDraft);
      setChatDraftAttachments(nextAtts);
    }
  }, [chatDraft, chatDraftAttachments]);

  const scopeForBotRef = useRef(scopeForBot);
  scopeForBotRef.current = scopeForBot;
  const mergeWithdrawnToLocalScopeRef = useRef(mergeWithdrawnToLocalScope);
  mergeWithdrawnToLocalScopeRef.current = mergeWithdrawnToLocalScope;
  const removePendingRef = useRef(removePending);
  removePendingRef.current = removePending;

  const requestStopBot = useCallback((bot: UnifiedBotItem): Promise<unknown> => {
    const inflight = stopInFlightRef.current.get(bot.key);
    if (inflight) return inflight;
    const task = (async () => {
      const scopeKey = scopeForBotRef.current(bot);
      if (bot.hostKind === 'local') {
        const env = await BotHost.call({ method: 'abort', params: { botId: bot.botId } });
        const res = env.result as AbortBotResult | undefined;
        if (res?.withdrawn?.length) {
          await mergeWithdrawnToLocalScopeRef.current(bot, scopeKey, res.withdrawn, true);
        }
      } else {
        if (!bot.remoteIdentity || !remoteClientRef.current) {
          throw new Error(t('目标离线，未停止。', 'Target offline; not stopped.'));
        }
        const api = remoteClientRef.current.api;
        const identity = bot.remoteIdentity;
        const outboxWithdrawn: WithdrawnTurnItem[] = [];
        try {
          const page = await api.pending(identity, 'pending_list', { options: { state: 'pending', limit: 50 } });
          for (const rec of page.items) {
            if (rec.kind === 'primary' && rec.botId === bot.botId && rec.targetDeviceId === identity.targetDeviceId) {
              const cancelled = await api.pending(identity, 'pending_cancel', { id: rec.id }).catch(() => null);
              if (cancelled?.state === 'rejected') {
                outboxWithdrawn.push({
                  requestId: rec.requestId,
                  text: rec.text,
                  ...(rec.attachments?.length ? { attachments: rec.attachments } : {}),
                  delivery: rec.delivery ?? 'followUp',
                });
              }
            }
          }
        } catch {
          // Ignore local outbox scan error; remote abort still proceeds.
        }
        const res = await api.call(identity, 'abort', { botId: bot.botId });
        const combined: WithdrawnTurnItem[] = [];
        const seen = new Set<string>();
        for (const item of [...(res?.withdrawn ?? []), ...outboxWithdrawn]) {
          if (!item?.requestId || seen.has(item.requestId)) continue;
          seen.add(item.requestId);
          combined.push(item);
        }
        if (combined.length > 0) {
          for (const w of combined) {
            if (scopeKey) removePendingRef.current(scopeKey, w.requestId);
          }
          const attachmentIds = combined.flatMap(w => w.attachments ?? []);
          const resolvedAtts = await resolveAttachmentMetasByIds(
            attachmentIds,
            attachmentIds.length > 0
              ? (attachmentId: string) => api.call(identity, 'getAttachment', { botId: bot.botId, attachmentId }) as Promise<ImageAttachmentData>
              : null,
          );
          mergeRecalledByTarget(
            api,
            identity,
            { kind: 'primary', id: bot.botId },
            combined.map(w => extractEditableUserText(w.text)),
            resolvedAtts,
          );
        }
      }
    })();
    stopInFlightRef.current.set(bot.key, task);
    setStopping(prev => (prev.has(bot.key) ? prev : new Set(prev).add(bot.key)));
    const cleanup = () => {
      if (stopInFlightRef.current.get(bot.key) === task) stopInFlightRef.current.delete(bot.key);
      setStopping(prev => {
        if (!prev.has(bot.key)) return prev;
        const next = new Set(prev);
        next.delete(bot.key);
        return next;
      });
    };
    task.then(cleanup, cleanup);
    return task;
  }, [t]);

  const restoreFailedAdmission = useCallback(async (requestId: string) => {
    const bot = activeBot;
    if (!bot || !requestId || queueActionBusy) return;
    const scopeKey = scopeForBotRef.current(bot);
    setQueueActionBusy(true);
    try {
      if (bot.hostKind === 'local') {
        const env = await BotHost.call({
          method: 'withdrawQueued',
          params: { botId: bot.botId, requestId },
        });
        const res = env.result as WithdrawQueuedResult | undefined;
        if (res?.withdrawn?.length) {
          await mergeWithdrawnToLocalScopeRef.current(bot, scopeKey, res.withdrawn, true);
          requestAnimationFrame(() => composerTextareaRef.current?.focus());
        }
      } else {
        if (!bot.remoteIdentity || !remoteClientRef.current || !remoteConnected || bot.online === false) {
          setOfflineNotice({ botKey: bot.key, text: t('目标离线，无法恢复编辑。', 'Target offline; cannot restore to edit.') });
          return;
        }
        const api = remoteClientRef.current.api;
        const identity = bot.remoteIdentity;
        const res = await api.call(identity, 'withdrawQueued', { botId: bot.botId, requestId });
        const withdrawn = Array.isArray(res?.withdrawn) ? res.withdrawn : [];
        if (withdrawn.length > 0) {
          for (const w of withdrawn) {
            if (scopeKey) removePendingRef.current(scopeKey, w.requestId);
          }
          const attachmentIds = withdrawn.flatMap(w => w.attachments ?? []);
          const resolvedAtts = await resolveAttachmentMetasByIds(
            attachmentIds,
            attachmentIds.length > 0
              ? (attachmentId: string) => api.call(identity, 'getAttachment', { botId: bot.botId, attachmentId }) as Promise<ImageAttachmentData>
              : null,
          );
          mergeRecalledByTarget(
            api,
            identity,
            { kind: 'primary', id: bot.botId },
            withdrawn.map(w => (w.attachments?.length ? stripTrailingHostAttachmentLines(w.text, w.attachments.length) : w.text)),
            resolvedAtts,
          );
        }
      }
    } catch (error) {
      action.setError(errorText(error));
    } finally {
      setQueueActionBusy(false);
    }
  }, [activeBot, queueActionBusy, remoteConnected, action, t]);

  const canSteerLocal = canSteerBotActivity({
    activity: rawBotActivity,
    online: isChatTargetOnline,
    archived: Boolean(!activeBot || activeBot.archivedAt),
    isStopping: isStoppingBot,
  });

  const localQueuedStripItems = useMemo(() => {
    if (activeBot?.hostKind !== 'local') return [];
    const items = mergeQueuedStripItems(effectiveChatLive?.queuedItems);
    const hiddenIds = new Set<string>();
    if (chatTurnAdmission && chatTurnAdmission.phase !== 'queued') {
      hiddenIds.add(chatTurnAdmission.requestId);
    }
    if (rawBotActivity.phase === 'preparing' && rawBotActivity.requestId) {
      hiddenIds.add(rawBotActivity.requestId);
    }
    return hiddenIds.size > 0 ? items.filter(item => !hiddenIds.has(item.requestId)) : items;
  }, [activeBot?.hostKind, effectiveChatLive?.queuedItems, chatTurnAdmission, rawBotActivity.phase, rawBotActivity.requestId]);

  const recallLocalQueuedItem = useCallback(async (item: UnifiedQueuedStripItem, mergeIntoDraft = true) => {
    const bot = activeBot;
    if (!bot || bot.hostKind !== 'local' || queueActionBusy) return;
    const scopeKey = scopeForBotRef.current(bot);
    setQueueActionBusy(true);
    try {
      const env = await BotHost.call({
        method: 'withdrawQueued',
        params: { botId: bot.botId, requestId: item.requestId },
      });
      const res = env.result as WithdrawQueuedResult | undefined;
      if (res?.withdrawn?.length) {
        await mergeWithdrawnToLocalScopeRef.current(bot, scopeKey, res.withdrawn, mergeIntoDraft);
        if (mergeIntoDraft) {
          requestAnimationFrame(() => composerTextareaRef.current?.focus());
        }
      }
    } catch (error) {
      action.setError(errorText(error));
    } finally {
      setQueueActionBusy(false);
    }
  }, [activeBot, queueActionBusy, action]);

  const recallAllLocalQueued = useCallback(async () => {
    const bot = activeBot;
    if (!bot || bot.hostKind !== 'local' || queueActionBusy) return;
    const scopeKey = scopeForBotRef.current(bot);
    setQueueActionBusy(true);
    try {
      const env = await BotHost.call({
        method: 'withdrawQueued',
        params: { botId: bot.botId },
      });
      const res = env.result as WithdrawQueuedResult | undefined;
      if (res?.withdrawn?.length) {
        await mergeWithdrawnToLocalScopeRef.current(bot, scopeKey, res.withdrawn, true);
        requestAnimationFrame(() => composerTextareaRef.current?.focus());
      }
    } catch (error) {
      action.setError(errorText(error));
    } finally {
      setQueueActionBusy(false);
    }
  }, [activeBot, queueActionBusy, action]);

  const steerLocalQueuedItem = useCallback(async (item: UnifiedQueuedStripItem) => {
    const bot = activeBot;
    if (!bot || bot.hostKind !== 'local' || queueActionBusy || !canSteerLocal) return;
    setQueueActionBusy(true);
    try {
      await BotHost.call({
        method: 'steerQueued',
        params: { botId: bot.botId, requestId: item.requestId },
      });
    } catch (error) {
      action.setError(errorText(error));
    } finally {
      setQueueActionBusy(false);
    }
  }, [activeBot, queueActionBusy, canSteerLocal, action]);

  /** 问卷提交走现有 callCapabilityAction；deviceId/botId 由宿主授权，不自建协议。 */
  const submitQuestionnaire = useCallback(
    async (installationId: string, input: QuestionnaireSubmitPayload) => {
      if (!activeBot) throw new Error(t('目标不可用，未提交', 'Target unavailable; not submitted'));
      if (activeBot.archivedAt) throw new Error(t('该 Bot 已归档，不能提交', 'This bot is archived; not submitted'));
      if (activeBot.hostKind === 'local') {
        const deviceId = localHost?.deviceId;
        if (localHost?.phase !== 'running' || !deviceId || activeBot.deviceId !== deviceId) {
          throw new Error(t('本机设备身份未就绪，未提交', 'Local device identity not ready; not submitted'));
        }
        const env = await BotHost.call({
          method: 'callCapabilityAction',
          params: {
            installationId,
            action: 'answerQuestionnaire',
            request: { requestId: uuid(), deviceId, botId: activeBot.botId, input },
          },
        });
        const body = env?.result as { result?: unknown } | undefined;
        return body && typeof body === 'object' && 'result' in body ? body.result : body;
      }
      const api = remoteClientRef.current?.api;
      const identity = activeBot.remoteIdentity;
      if (!api || !identity || !remoteConnected || activeBot.online === false) {
        throw new Error(t('目标设备离线，未提交', 'Target device offline; not submitted'));
      }
      const res = await api.call(identity, 'callCapabilityAction', {
        installationId,
        action: 'answerQuestionnaire',
        request: { requestId: uuid(), deviceId: identity.targetDeviceId, botId: activeBot.botId, input },
      });
      return (res as { result?: unknown })?.result;
    },
    [activeBot, localHost?.phase, localHost?.deviceId, remoteConnected, t],
  );

  const activeLiveToolName = useMemo(() => {
    const tools = array<Record<string, unknown>>(effectiveChatLive?.tools);
    for (let i = tools.length - 1; i >= 0; i--) {
      const slot = tools[i];
      const name = typeof slot?.name === 'string' ? slot.name.trim() : '';
      const status = typeof slot?.status === 'string' ? slot.status : '';
      if (name && (status === 'running' || status === 'pending' || status === 'started' || !status)) {
        return name;
      }
    }
    const last = tools[tools.length - 1];
    return typeof last?.name === 'string' && effectiveChatLive?.busy && !liveGeneratingText
      ? last.name.trim()
      : null;
  }, [effectiveChatLive?.tools, effectiveChatLive?.busy, liveGeneratingText]);

  const prevChatBusyRef = useRef(false);
  useEffect(() => {
    const wasBusy = prevChatBusyRef.current;
    prevChatBusyRef.current = isBotBusy;
    if (!wasBusy || isBotBusy || screen !== 'chat' || !active || !activeBot || document.hidden) return;
    const targetBot = activeBot;
    const scopeKey = currentChatScope.current;
    const read = (fresh: () => boolean): Promise<BotHistoryReadResult | null> => {
      if (targetBot.hostKind === 'local') {
        return fetchBotHistoryPages(async (cursor, limit, chunked) => {
          if (!fresh()) return null;
          const env = await BotHost.call({
            method: 'history',
            params: { botId: targetBot.botId, limit, ...(chunked ? { chunked: true } : {}), ...(cursor ? { cursor } : {}) },
          });
          return (env.result as HostHistoryPage) ?? null;
        });
      }
      if (targetBot.hostKind === 'remote' && targetBot.remoteIdentity && remoteClientRef.current?.api.transportConnected) {
        const api = remoteClientRef.current.api;
        const identity = targetBot.remoteIdentity;
        return fetchBotHistoryPages(async (cursor, limit, chunked) => {
          if (!fresh()) return null;
          const page = await api.call(identity, 'history', {
            botId: targetBot.botId,
            limit,
            ...(chunked ? { chunked: true } : {}),
            ...(cursor ? { cursor } : {}),
          });
          return (page as unknown as HostHistoryPage) ?? null;
        });
      }
      return Promise.resolve(null);
    };
    const historyEpoch = chatHistoryEpoch.current;
    const scopeStillCurrent = () => currentChatScope.current === scopeKey && chatHistoryEpoch.current === historyEpoch;
    const go = () => sharedHistoryRead(chatHistoryFlights.current, scopeKey, chatHistoryEpoch, scopeStillCurrent, read);
    // 共享到更早启动的读可能错过忙期收尾追加：复用他人 flight（非本 effect 发起）时再补读一次。
    const shared = Boolean(scopeKey && chatHistoryFlights.current.get(scopeKey));
    void (!scopeKey ? Promise.resolve(null) : go())
      .then(result => {
        if (result && scopeStillCurrent()) {
          applyFetchedHistory(targetBot.key, scopeKey, result, { updateMeta: true });
        }
        if ((result === null || shared) && scopeStillCurrent()) {
          void go().then(follow => {
            if (follow && scopeStillCurrent()) {
              applyFetchedHistory(targetBot.key, scopeKey, follow, { updateMeta: true });
            }
          }).catch(() => {});
        }
      })
      .catch(() => {
        // Ignore background refresh error
      });
  }, [isBotBusy, screen, active, activeBot, applyFetchedHistory]);

  const chatTargetOnline = Boolean(
    activeBot &&
      (activeBot.hostKind === 'local'
        ? localHost?.phase === 'running' && activeBot.deviceId === localHost?.deviceId
        : remoteConnected && activeBot.online !== false),
  );
  const activeDurableWaits =
    !activeBot || activeBot.archivedAt || recoveringChat || !chatTargetOnline || Boolean(chatObservationError)
      ? undefined
      : effectiveChatLive?.durableWaits;

  const allChatItems = useMemo(() => {
    if (!activeBot) return [] as Array<Record<string, unknown>>;
    // raw history 是旧页，live 投影是新窗口：按 entry id 去重排序；同 id 保留 raw（工具/思考细节更全），
    // 同时合入 Host 投影的 durable wait 状态（缺省 = 不支持/离线 -> 只读；[] = 已知无活跃）。
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of array<Record<string, unknown>>(effectiveChatLive?.history)) {
      byId.set(String(item.id), mergeHistoryWaitProjection(item, undefined, activeDurableWaits));
    }
    for (const item of chatHistory) {
      byId.set(String(item.id), mergeHistoryWaitProjection(item, byId.get(String(item.id)), activeDurableWaits));
    }
    const numericId = (item: Record<string, unknown>) => {
      const id = Number(item.id);
      return Number.isFinite(id) ? id : 0;
    };
    const rawSorted = [...byId.values()].sort((a, b) => numericId(a) - numericId(b));
    const effectiveClearedAfter = Math.max(currentClearedAfter, maxResetEntryId(rawSorted));
    return filterHistoryAfterCutoff(rawSorted, effectiveClearedAfter);
  }, [chatHistory, effectiveChatLive, activeBot, currentClearedAfter, activeDurableWaits]);

  // generation.attribution 缺失但 tools 仍活跃时，用合并历史中最新执行来源判断当前是否群聊后台工作；
  // 1v1 Bot 私聊（dm）与用户主聊（primary）均在当前 Bot 的 1v1 对话页内实时流式展示。
  const chatLiveIsCollaborative = Boolean(
    isBotBusy &&
      (liveGenerationAttr?.channel ?? latestEntryChannel(allChatItems, activeBot?.botId)) === 'room',
  );
  // 群聊工作的流式文本/工具名不渲染进 1v1 聊天忙状态。
  const displayLiveToolName = chatLiveIsCollaborative || hideToolOutput ? null : activeLiveToolName;
  const displayGeneratingText = chatLiveIsCollaborative ? '' : liveGeneratingText;

  const allChatTurns = useMemo(() => {
    if (!activeBot) return [];
    const effectiveClearedAfter = Math.max(currentClearedAfter, maxResetEntryId(allChatItems));
    return parseHistoryEntries(allChatItems, effectiveClearedAfter, {
      liveTools: recoveringChat ? undefined : array<Record<string, unknown>>(effectiveChatLive?.tools),
      isBusy: isBotBusy,
      // 群聊（room）生成的流式文本不进 1v1 聊天：隐藏轮由 parser 归轮过滤。
      liveGeneratingText: displayGeneratingText,
      // 与 displayGeneratingText 同一过滤口径：缺 attribution 的群聊生成块同样不进 1v1 聊天。
      liveGeneratingBlocks: chatLiveIsCollaborative ? undefined : effectiveChatLive?.generation?.blocks,
      // 当前 Bot 为 self echo（outgoing）判定锚点；live 流式轮的 attribution 由生成帧携带。
      selfBotId: activeBot.botId,
      liveAttribution: liveGenerationAttr,
      knownBots,
      durableWaits: activeDurableWaits,
    });
  }, [allChatItems, effectiveChatLive, activeBot, currentClearedAfter, recoveringChat, isBotBusy, liveGeneratingText, liveGenerationAttr, chatLiveIsCollaborative, knownBots, activeDurableWaits]);

  const currentGoogleSetup = useMemo(
    () => selectCurrentGoogleSetup(allChatTurns),
    [allChatTurns],
  );

  const activeTurnStartedAt = useMemo(
    () => resolveActiveTurnStartedAt(botActivity),
    [botActivity],
  );

  const displayedChatTurns = useMemo(
    () => hideToolOutput ? chatTurnsWithoutToolOutput(allChatTurns) : allChatTurns,
    [allChatTurns, hideToolOutput],
  );
  const chatSearchActive = chatSearchOpen && Boolean(chatSearchQuery.trim());
  const visibleTurns = useMemo(() => {
    const q = chatSearchQuery.trim().toLowerCase();
    if (!chatSearchOpen || !q) return displayedChatTurns;
    return displayedChatTurns.filter(
      turn =>
        turn.text.toLowerCase().includes(q) ||
        (!hideToolOutput && Boolean(
          turn.tools?.some(
            tool =>
              tool.name.toLowerCase().includes(q) ||
              (tool.argSummary && tool.argSummary.toLowerCase().includes(q)) ||
              (tool.output && tool.output.toLowerCase().includes(q)),
          ),
        )),
    );
  }, [displayedChatTurns, chatSearchOpen, chatSearchQuery, hideToolOutput]);

  const markViewedBoardResult = useMarkViewedBoardResult(board, activeBoardTarget, active && screen === 'chat');
  useEffect(() => {
    markViewedBoardResult(visibleAssistantTextEntryIds(visibleTurns));
  }, [visibleTurns, markViewedBoardResult]);

  const latestTurnToolCount = visibleTurns.at(-1)?.tools?.length ?? 0;

  // 从私聊/群聊返回聊天时恢复离开前 scrollTop：layout effect 先置位，
  // 同一提交内的自动滚底 effect 看到 pending 标记即跳过这一次。
  const prevChatEnteredRef = useRef(false);
  const prevChatTargetKeyRef = useRef('');
  const prevChatMetricsRef = useRef({
    turnsCount: 0,
    latestTurnId: '',
    latestTurnLen: 0,
    latestTurnTools: 0,
    generatingLen: 0,
    liveToolName: '',
    failureNotice: '',
  });
  const latestDisplayedTurn = displayedChatTurns.at(-1);
  const latestDisplayedTurnId = latestDisplayedTurn?.id ?? '';
  const latestDisplayedTurnLen = latestDisplayedTurn?.text.length ?? 0;
  const latestDisplayedTurnTools = latestDisplayedTurn?.tools?.length ?? 0;
  const chatTargetKey = `${activeBot?.key ?? ''}|${activeChatScope}`;
  useLayoutEffect(() => {
    if (screen !== 'chat') return;
    const saved = chatScrollRestoreRef.current;
    if (saved === null) return;
    chatScrollRestoreRef.current = null;
    chatScrollRestorePending.current = true;
    const el = chatScrollRef.current;
    if (el) {
      el.scrollTop = saved;
      chatStickToBottomRef.current = isNearChatBottom(el.scrollHeight, saved, el.clientHeight);
    }
  }, [screen]);
  useLayoutEffect(() => {
    if (screen !== 'chat') {
      prevChatEnteredRef.current = false;
      return;
    }
    const el = chatScrollRef.current;
    if (!el) return;

    const currentMetrics = {
      turnsCount: displayedChatTurns.length,
      latestTurnId: latestDisplayedTurnId,
      latestTurnLen: latestDisplayedTurnLen,
      latestTurnTools: latestDisplayedTurnTools,
      generatingLen: displayGeneratingText.length,
      liveToolName: displayLiveToolName ?? '',
      failureNotice: failureNotice ?? '',
    };
    const prev = prevChatMetricsRef.current;
    const justEntered = !prevChatEnteredRef.current;
    const targetChanged = prevChatTargetKeyRef.current !== chatTargetKey;
    prevChatEnteredRef.current = true;
    prevChatTargetKeyRef.current = chatTargetKey;
    prevChatMetricsRef.current = currentMetrics;

    const restorePending = chatScrollRestorePending.current;
    if (restorePending) {
      // 本帧是返回恢复，不覆盖刚置回的 scrollTop；后续贴底时新消息仍自动滚底。
      chatScrollRestorePending.current = false;
    }

    const decision = decideChatAutoScroll({
      restorePending,
      justEntered,
      targetChanged,
      stickToBottom: chatStickToBottomRef.current,
      jumpingToBottom: chatJumpingToBottomRef.current,
      searchOpen: chatSearchOpen,
      prevMetrics: prev,
      currentMetrics,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
    });

    chatStickToBottomRef.current = decision.nextStickToBottom;
    chatJumpingToBottomRef.current = decision.nextJumpingToBottom;

    switch (decision.action) {
      case 'skip-restore':
      case 'noop':
        break;
      case 'force-bottom':
      case 'scroll-bottom':
        setChatHasNewContent(false);
        el.scrollTop = el.scrollHeight;
        break;
      case 'smooth-bottom':
        setChatHasNewContent(false);
        if (typeof el.scrollTo === 'function') {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        } else {
          el.scrollTop = el.scrollHeight;
        }
        break;
      case 'reset-empty':
        setChatHasNewContent(false);
        break;
      case 'show-jump-pill':
        setChatHasNewContent(true);
        break;
    }
  }, [
    screen,
    chatTargetKey,
    displayedChatTurns.length,
    latestDisplayedTurnId,
    latestDisplayedTurnLen,
    latestDisplayedTurnTools,
    visibleTurns.length,
    latestTurnToolCount,
    displayGeneratingText,
    isBotBusy,
    displayLiveToolName,
    failureNotice,
    chatSearchOpen,
  ]);

  const [hubRefreshing, setHubRefreshing] = useState(false);
  const hubRefreshRunning = useRef(false);
  const [pullDistance, setPullDistance] = useState(0);
  const hubScrollRef = useRef<HTMLDivElement | null>(null);
  const pullTouchRef = useRef<{ startY: number; startX: number; pulling: boolean } | null>(null);
  const PULL_THRESHOLD = 62;

  const triggerHubRefresh = useCallback(async () => {
    if (hubRefreshRunning.current) return;
    hubRefreshRunning.current = true;
    setHubRefreshing(true);
    try {
      const results = await Promise.allSettled([
        syncLocalBots(),
        (async () => {
          await onRefreshConnection?.();
          await ensureRemoteApi();
          await syncRemoteBots();
        })(),
        // 下拉刷新同时刷新群聊列表：await 实际读取结束才收起刷新态（静默失败由 hook 自身 error 呈现）。
        refreshRoomConversationsRef.current(),
      ]);
      if (results[1].status === 'rejected') setDirectoryError(errorText(results[1].reason));
    } finally {
      hubRefreshRunning.current = false;
      setHubRefreshing(false);
      setPullDistance(0);
    }
  }, [onRefreshConnection, ensureRemoteApi, syncLocalBots, syncRemoteBots]);

  const popScreen = useCallback((): boolean => {
    const currentStack = nav.stackRef.current;
    const leaving = currentStack[currentStack.length - 1];
    if (!leaving || currentStack.length <= 1) return false;
    if (leaving.screen === 'bot-profile-manage') {
      restoreProfileManageFocus.current = true;
    }
    if (leaving.screen === 'chat') {
      chatLoadGeneration.current += 1;
      profileLoadGeneration.current += 1;
      scheduleLoadGeneration.current += 1;
      cancelActiveObservation();
      setChatTopMenuOpen(false);
    }
    if (leaving.screen === 'conversation') {
      setRoomSettingsOpen(false);
    }
    const next = nav.pop();
    if (!next) return false;
    if (next.botKey && (next.screen === 'bot-profile' || next.screen === 'chat')) {
      setActiveBotKey(next.botKey);
    }
    if (leaving.screen === 'chat' && next.screen === 'tasks' && taskReturnId) {
      setActiveTaskId(taskReturnId);
      setCreatingTask(false);
      setTaskInitialEditMode(false);
    }
    if (leaving.screen === 'settings-center-admin' || leaving.screen === 'bot-skills') {
      refreshDirectoryAfterConfig();
    }
    return true;
  }, [nav.pop, nav.stackRef, cancelActiveObservation, taskReturnId, refreshDirectoryAfterConfig]);

  const openCenterSettings = useCallback(() => {
    nav.push({ screen: 'settings', settingsPage: 'connection' });
  }, [nav.push]);

  const openInAppCenterAdmin = useCallback((tab: CenterAdminTab = 'providers') => {
    setCenterAdminTab(tab);
    nav.push({ screen: 'settings-center-admin' });
  }, [nav.push]);

  const closeInAppCenterAdmin = useCallback(() => {
    if (!popScreen()) {
      nav.resetTo({ screen: 'settings', settingsPage: 'overview' });
      refreshDirectoryAfterConfig();
    }
  }, [popScreen, nav.resetTo, refreshDirectoryAfterConfig]);

  const closeBotProfile = useCallback(() => {
    if (!popScreen()) {
      nav.resetTo({ screen: 'hub' });
    }
  }, [popScreen, nav.resetTo]);

  const backFromSettings = useCallback(() => {
    popScreen();
  }, [popScreen]);

  const backFromProfileManage = useCallback(() => {
    restoreProfileManageFocus.current = true;
    if (!popScreen()) {
      nav.push({ screen: 'bot-profile', botKey: activeBotKey });
    }
  }, [popScreen, nav.push, activeBotKey]);

  // Step-by-step Back Navigation for Android full-screen back gesture & hardware Back button:
  // 1. Dismiss topmost overlay/sheet/dialog/popover/menu or in-screen sub-state.
  // 2. Guard mandatory flows (e.g. first primary Bot creation).
  // 3. Pop the unified navigation stack; return false at root so native Back takes over.
  const handleStepBack = useCallback((): boolean => {
    if (leftDrawerOpen) {
      setLeftDrawerOpen(false);
      return true;
    }
    if (clearConfirmOpen) {
      setClearConfirmOpen(false);
      return true;
    }
    if (roomDeleteModal) {
      if (!roomDeleteModal.submitting) {
        roomDeleteFetchSeqRef.current += 1;
        setRoomDeleteModal(null);
      }
      return true;
    }
    if (botConfirmModal) {
      if (!action.busy) setBotConfirmModal(null);
      return true;
    }
    if (bubbleActionTurn) {
      setBubbleActionTurn(null);
      return true;
    }
    if (modelTarget) {
      closeModelTarget();
      return true;
    }
    if (hubContextMenu) {
      setHubContextMenu(null);
      return true;
    }
    if (screen === 'conversation' && roomSettingsOpen) {
      setRoomSettingsOpen(false);
      return true;
    }
    if (screen === 'dm' && dmSelectedScopeId) {
      setDmSelectedScopeId(null);
      return true;
    }
    if (screen === 'bot-profile' && vaultTargetKey) {
      setVaultTargetKey(null);
      return true;
    }
    if (screen === 'bot-schedules') {
      if (scheduleDeleteTarget) {
        if (!action.busy) setScheduleDeleteTarget(null);
        return true;
      }
      if (scheduleEditing !== null) {
        setScheduleEditing(null);
        return true;
      }
    }
    if (screen === 'hub' && hubAddMenuOpen) {
      setHubAddMenuOpen(false);
      return true;
    }
    if (screen === 'chat') {
      if (chatTopMenuOpen) {
        setChatTopMenuOpen(false);
        return true;
      }
      if (composerMenuOpen) {
        setComposerMenuOpen(false);
        return true;
      }
      if (chatSearchOpen) {
        setChatSearchOpen(false);
        setChatSearchQuery('');
        return true;
      }
      if (editingTurn) {
        if (!editSubmitting) setEditingTurn(null);
        return true;
      }
    }
    if (screen === 'tasks') {
      if (creatingTask) {
        if (globalTasks.createDraft.trim()) globalTasks.markDraftLeftUnpublished();
        setCreatingTask(false);
        return true;
      }
      if (activeTaskId !== null) {
        setActiveTaskId(null);
        setTaskInitialEditMode(false);
        return true;
      }
    }
    if (screen === 'hub' && searchQuery.trim()) {
      setSearchQuery('');
      return true;
    }
    if (screen === 'group-create' && groupCreating) {
      return true;
    }
    if (screen === 'bot-edit' && mustCreatePrimaryBot && editMode === 'create') {
      setPrimaryBackNotice(prev => ({
        text: t('请先创建主 Bot', 'Create a primary Bot first'),
        seq: (prev?.seq ?? 0) + 1,
      }));
      return true;
    }
    return popScreen();
  }, [
    leftDrawerOpen,
    clearConfirmOpen,
    roomDeleteModal,
    botConfirmModal,
    bubbleActionTurn,
    action.busy,
    modelTarget,
    closeModelTarget,
    hubContextMenu,
    screen,
    roomSettingsOpen,
    dmSelectedScopeId,
    vaultTargetKey,
    scheduleDeleteTarget,
    scheduleEditing,
    hubAddMenuOpen,
    chatTopMenuOpen,
    composerMenuOpen,
    chatSearchOpen,
    editingTurn,
    editSubmitting,
    creatingTask,
    activeTaskId,
    globalTasks.createDraft,
    globalTasks.markDraftLeftUnpublished,
    searchQuery,
    groupCreating,
    mustCreatePrimaryBot,
    editMode,
    popScreen,
    t,
  ]);

  useEffect(() => {
    if (!active) return;
    const onAppBack = (ev: Event) => {
      if (handleStepBack()) {
        ev.preventDefault();
      }
    };
    window.addEventListener('app-back', onAppBack);
    return () => window.removeEventListener('app-back', onAppBack);
  }, [active, handleStepBack]);

  // Android Pull-to-Refresh gesture on Hub Scroll Area
  const onHubScrollTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (hubRefreshing) return;
    const scrollEl = hubScrollRef.current;
    if (!scrollEl || scrollEl.scrollTop > 2) {
      pullTouchRef.current = null;
      return;
    }
    const touch = e.touches[0];
    if (!touch) return;
    pullTouchRef.current = {
      startY: touch.clientY,
      startX: touch.clientX,
      pulling: false,
    };
  };

  const onHubScrollTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const state = pullTouchRef.current;
    const scrollEl = hubScrollRef.current;
    if (!state || !scrollEl || hubRefreshing) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dy = touch.clientY - state.startY;
    const dx = Math.abs(touch.clientX - state.startX);
    if (!state.pulling) {
      if (dy > 10 && dy > dx * 1.2 && scrollEl.scrollTop <= 0) {
        state.pulling = true;
      } else if (dy < -6 || dx > 28) {
        pullTouchRef.current = null;
        setPullDistance(0);
        return;
      }
    }
    if (state.pulling) {
      if (dx > dy * 1.2) {
        pullTouchRef.current = null;
        setPullDistance(0);
        return;
      }
      if (scrollEl.scrollTop > 0 || dy <= 0) {
        setPullDistance(0);
        return;
      }
      const damped = Math.min(96, Math.round(Math.pow(dy, 0.82) * 1.6));
      setPullDistance(damped);
    }
  };

  const onHubScrollTouchEnd = () => {
    const state = pullTouchRef.current;
    pullTouchRef.current = null;
    if (!state || !state.pulling) {
      if (!hubRefreshing) setPullDistance(0);
      return;
    }
    if (pullDistance >= PULL_THRESHOLD) {
      void triggerHubRefresh();
    } else {
      setPullDistance(0);
    }
  };

  useEffect(() => {
    const el = composerTextareaRef.current;
    if (!el) return;
    if (!effectiveLocalDraft) {
      el.style.height = '36px';
    } else {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
    }
  }, [effectiveLocalDraft, screen]);

  /** 本机历史/发送后附件按需取图：统一走 BotHost.call getAttachment。 */
  const localAttachmentFetcher = useMemo<AttachmentFetcher | null>(() => {
    const bot = activeBot;
    if (!bot || bot.hostKind !== 'local') return null;
    return async (attachmentId) => {
      const env = await BotHost.call({
        method: 'getAttachment',
        params: { botId: bot.botId, attachmentId },
      });
      return env.result as ImageAttachmentData;
    };
  }, [activeBot]);

  /** 远端（手机远端页）历史附件按需取图：走 remote api.call 到目标 Host。 */
  const remoteAttachmentFetcher = useCallback((api: DesktopPanelApi, identity: DesktopIdentity, botId: string): AttachmentFetcher => {
    return async (attachmentId) => {
      return api.call(identity, 'getAttachment', { botId, attachmentId }) as Promise<ImageAttachmentData>;
    };
  }, []);

  /** Tauri（Android ）界面才有原生选图/拍照；浏览器走 input type=file。 */
  const inTauriUi = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

  const editingTurnRef = useRef(editingTurn);
  editingTurnRef.current = editingTurn;

  /** 本机：上传走 BotHost.call uploadAttachment；归属冻结在发起时的 scope/botId——
   *  切换聊天后完成的上传仍只写原 scope 磁盘草稿，不回填当前 React state。
   *  相同图片 id（content SHA-256，与 backend id 一致）去重，避免 backend duplicate 拒绝。 */
  const uploadLocalImages = useCallback(async (botId: string, scope: string, sources: PickedImageSource[], targetEditEntryId?: number) => {
    const getCurrentList = () => {
      if (targetEditEntryId !== undefined) {
        const cur = editingTurnRef.current;
        return cur && cur.scopeKey === scope && cur.entryId === targetEditEntryId ? cur.attachments : null;
      }
      return readChatDraftAttachments(scope);
    };
    const initialList = getCurrentList();
    if (!initialList) return;
    const existing = new Set(initialList.map((a) => a.id));
    const queued: PickedImageSource[] = [];
    for (const source of sources) {
      const id = await attachmentIdOf(source.data);
      if (existing.has(id)) continue; // 同图重选：附件已在草稿中，跳过上传
      existing.add(id);
      queued.push(source);
    }
    // 去重后总数/总字节上限校验：超限整体拒绝，保留原草稿（不静默丢最早附件）。
    if (initialList.length + queued.length > IMAGE_MAX_COUNT) {
      throw new ImagePickError('IMAGE_TOO_MANY', t(`最多 ${IMAGE_MAX_COUNT} 张图片，本次未上传。`, `At most ${IMAGE_MAX_COUNT} images; nothing uploaded.`));
    }
    const totalBytes = initialList.reduce((sum, a) => sum + a.size, 0)
      + queued.reduce((sum, s) => sum + s.size, 0);
    if (totalBytes > IMAGE_MAX_TOTAL_BYTES) {
      throw new ImagePickError('IMAGE_TOO_LARGE', t(`图片总大小超过 ${IMAGE_MAX_TOTAL_BYTES / 1048576}MB，本次未上传。`, `Total image size exceeds ${IMAGE_MAX_TOTAL_BYTES / 1048576}MB; nothing uploaded.`));
    }
    for (const source of queued) {
      const env = await BotHost.call({
        method: 'uploadAttachment',
        params: {
          botId,
          name: attachmentFileName(source.name, source.mimeType),
          mimeType: source.mimeType,
          data: source.data,
        },
      });
      const att = env.result as ImageAttachment;
      if (targetEditEntryId !== undefined) {
        const cur = editingTurnRef.current;
        if (!cur || cur.scopeKey !== scope || cur.entryId !== targetEditEntryId) return;
        setEditingTurn(prev =>
          prev && prev.scopeKey === scope && prev.entryId === targetEditEntryId && !prev.attachments.some(a => a.id === att.id)
            ? { ...prev, attachments: [...prev.attachments, att] }
            : prev,
        );
      } else {
        const next = [...readChatDraftAttachments(scope), att];
        writeChatDraftAttachments(scope, next);
        if (currentChatScope.current === scope) setChatDraftAttachments(next);
      }
    }
  }, [t]);

  const pickLocalImages = useCallback((source: 'photos' | 'camera', pastedFiles?: File[]) => {
    if (pastedFiles && pastedFiles.length === 0) return;
    if (imageUploading || Boolean(slashBusy) || editSubmitting) return;
    setComposerImageError('');
    const bot = activeBot;
    if (!bot || bot.hostKind !== 'local') return;
    const botId = bot.botId;
    const botKey = bot.key;
    const scope = currentChatScope.current;
    const targetEditEntryId = editingTurnRef.current?.botKey === botKey ? editingTurnRef.current.entryId : undefined;
    if (!scope) { setComposerImageError(t('目标身份尚未就绪，草稿已保留。', 'Target identity unavailable; draft retained.')); return; }
    const release = () => setImageUploading(false);
    const handleSources = async (sources: PickedImageSource[]) => {
      if (sources.length === 0) return;
      await uploadLocalImages(botId, scope, sources, targetEditEntryId);
      if (activeBot?.key === botKey) setComposerImageError('');
    };
    const handleFiles = async (files: File[]) => {
      const normalized = await Promise.all(files.map((file) => normalizeImageFile(file, file.name)));
      await handleSources(normalized);
    };
    setImageUploading(true);
    if (pastedFiles) {
      void handleFiles(pastedFiles)
        .catch((error) => { if (activeBot?.key === botKey) setComposerImageError(errorText(error)); })
        .finally(release);
      return;
    }
    if (inTauriUi) {
      void BotHost.pickImages({ source }).then(
        (result) => handleSources(result.cancelled ? [] : result.images),
      )
        .catch((error) => { if (activeBot?.key === botKey) setComposerImageError(errorText(error)); })
        .finally(release);
      return;
    }
    pickImagesFromInput({
      onPicked: async (files) => {
        try {
          await handleFiles(files);
        } catch (error) {
          if (activeBot?.key === botKey) setComposerImageError(errorText(error));
        }
      },
      onSettled: release,
    });
  }, [activeBot, imageUploading, inTauriUi, uploadLocalImages, slashBusy, editSubmitting, t]);

  const slash = useSlashAutocomplete({
    text: effectiveLocalDraft,
    // 未确认/待对账的原请求或历史编辑态也不得用命令绕过（recovering 不意味着可以清空）。
    disabled: !activeChatScope || Boolean(slashBusy) || Boolean(activeEditing) ||
      Boolean(activeBot && chatPending?.botKey === activeBot.key && chatPending.phase !== 'accepted'),
    onText: text => {
      setChatDraft(text);
      if (currentChatScope.current) writeChatDraft(currentChatScope.current, text);
    },
    onRun: command => void action.run(() => runSlashCommand(command)),
  });
  const anyDrawerOpen = leftDrawerOpen;
  const botIsOffline = (bot: UnifiedBotItem) => bot.hostKind === 'local'
    ? localHost?.phase !== 'running' : !remoteConnected || bot.online === false;
  const primaryPreset = primaryBot
    ? resolveBotAvatarPreset(botAvatarKey(primaryBot), primaryBot.role, true)
    : JARVIS_AVATAR_PRESET;

  // 电脑全屏视图（Grok Bot 风格）：本机与远程 Bot 共用同一全屏组件。
  const showerBotId = activeBot ? activeBot.botId : null;
  const showerHostKind = activeBot?.hostKind;
  const showerIdentity = activeBot?.remoteIdentity;
  const showerTarget = useMemo<ShowerTarget | null>(
    () => (showerBotId ? { botId: showerBotId } : null),
    [showerBotId],
  );
  // 远程 Bot 必须与当前连接档案/设备/代一致，否则不把旧设备的帧当当前画面。
  const showerRemoteReady = Boolean(
    showerHostKind === 'remote' &&
      remoteConnected &&
      showerIdentity &&
      remoteIdentity &&
      showerIdentity.profileId === remoteIdentity.profileId &&
      showerIdentity.generation === remoteIdentity.generation &&
      remoteDevices.some(device => device.deviceId === showerIdentity.targetDeviceId && device.online),
  );
  // 复用既有 remote 面板 call（与 Host 其它调用同源），绝不发给本机 BotHost；
  // 本机 Bot 不传 call，由 adapter 默认走 BotHost.call。
  const showerCall = useMemo<ShowerCall | undefined>(() => {
    if (showerHostKind !== 'remote' || !showerRemoteReady || !showerIdentity) return undefined;
    const api = remoteClientRef.current?.api;
    if (!api) return undefined;
    const call = api.call.bind(api) as (
      identity: DesktopIdentity,
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    return (method, params) => call(showerIdentity, method, params);
    // 远程目录每 2s 刷新会让 remoteIdentity 整体换新对象；call 只按真实身份字段稳定，换代时字段已变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showerHostKind,
    showerRemoteReady,
    showerIdentity?.profileId,
    showerIdentity?.targetDeviceId,
    showerIdentity?.generation,
    showerIdentity?.kind,
  ]);
  const showerConnected =
    showerHostKind === 'local' ? localHost?.phase === 'running' : showerRemoteReady;
  // 换主机/档案/设备/代/Bot 就换 key：旧画面与旧会话随卸载丢弃，不跨设备复用帧。
  const showerPreviewKey = `${showerHostKind ?? '-'}:${showerIdentity?.profileId ?? '-'}:${showerIdentity?.generation ?? '-'}:${showerIdentity?.targetDeviceId ?? '-'}:${showerBotId ?? '-'}:${showerHostKind === 'remote' ? showerRemoteReady : 'local'}`;

  const botPanelIdentityKey = JSON.stringify([activeCenter, activeBot?.key, activeBot?.deviceId,
    activeBot?.hostKind, showerIdentity?.profileId, showerIdentity?.generation, showerIdentity?.kind]);
  const botPanelConnected = Boolean(showerConnected &&
    (activeBot?.hostKind !== 'local' || activeBot.deviceId === localHost?.deviceId));
  const callBotPanel = useCallback(<M extends 'vaultControl' | 'reviewBotSkills',>(
    method: M,
    params: RemoteControlMethodMap[M]['params'],
  ) => {
    if (!activeBot || !botPanelConnected) return Promise.reject({ code: 'OFFLINE' });
    if (activeBot.hostKind === 'local') {
      if (localHostRef.current?.phase !== 'running' || localHostRef.current.deviceId !== activeBot.deviceId) {
        return Promise.reject({ code: 'OFFLINE' });
      }
      return BotHost.call({ method, params: params as Record<string, unknown> }).then(envelope => envelope.result);
    }
    const api = remoteClientRef.current?.api;
    const current = api?.identity;
    if (!api || !api.transportConnected || !current || !showerIdentity ||
      current.profileId !== showerIdentity.profileId || current.generation !== showerIdentity.generation ||
      current.kind !== showerIdentity.kind) {
      return Promise.reject({ code: 'NOT_CONNECTED' });
    }
    return api.call(showerIdentity, method, params);
  }, [activeBot, botPanelConnected, showerIdentity]);
  const callVault = useCallback<VaultCall>(input => callBotPanel('vaultControl', input), [callBotPanel]);
  const callSkillReview = useCallback<SkillReviewCall>(input => {
    if (!activeBot) return Promise.reject({ code: 'NOT_CONNECTED' });
    return callBotPanel('reviewBotSkills', { botId: activeBot.botId, input });
  }, [activeBot, callBotPanel]);
  // 主密码只走当前目标的私有控制通道，不进入聊天提交或待发队列。
  const submitVaultUnlock = useCallback(
    (input: VaultUnlockSubmitPayload) => callVault({ action: 'respondUnlock', ...input }),
    [callVault],
  );
  // Bot 内置浏览器与 Google 建项向导控制：volatile RPC 绑定当前目标 Host 与 Bot，不经持久 outbox。
  const callHostVolatile = useCallback(
    async (method: 'browserControl' | 'googleSetupControl', input: Record<string, unknown>) => {
      if (!activeBot || !botPanelConnected) throw Object.assign(new Error('Host offline'), { code: 'OFFLINE' });
      const payload = { ...input, botId: activeBot.botId };
      if (activeBot.hostKind === 'local') {
        if (localHostRef.current?.phase !== 'running' || localHostRef.current.deviceId !== activeBot.deviceId) {
          throw Object.assign(new Error('Local host offline'), { code: 'OFFLINE' });
        }
        const env = await BotHost.call({ method, params: payload });
        return (env?.result ?? {}) as Record<string, unknown>;
      }
      const api = remoteClientRef.current?.api;
      const current = api?.identity;
      if (
        !api ||
        !api.transportConnected ||
        !current ||
        !showerIdentity ||
        current.profileId !== showerIdentity.profileId ||
        current.generation !== showerIdentity.generation ||
        current.kind !== showerIdentity.kind
      ) {
        throw Object.assign(new Error('Target host not connected'), { code: 'NOT_CONNECTED' });
      }
      const rawApi = api as unknown as {
        call: (id: DesktopIdentity, m: string, params: Record<string, unknown>) => Promise<unknown>;
      };
      const res = await rawApi.call(showerIdentity, method, payload);
      return (res ?? {}) as Record<string, unknown>;
    },
    [activeBot, botPanelConnected, showerIdentity],
  );
  const callBrowser = useCallback<BotBrowserControlCall>(
    input => callHostVolatile('browserControl', input),
    [callHostVolatile],
  );
  const callGoogleSetup = useCallback<GoogleSetupControlCall>(
    async input => (await callHostVolatile('googleSetupControl', input)) as unknown as GoogleSetupControlState,
    [callHostVolatile],
  );
  const selectGoogleAccount = useCallback(
    async (selection: {
      email: string;
      requestId?: string;
      installationId?: string;
      conversationId?: number;
      cancelled?: boolean;
    }) => {
      if (!activeBot) throw new Error(t('目标不可用，未提交', 'Target unavailable; not submitted'));
      if (selection.requestId && selection.installationId) {
        const actionInput: Record<string, string | number | boolean> = {
          requestId: selection.requestId,
          account: selection.email,
          cancelled: Boolean(selection.cancelled),
        };
        if (selection.conversationId !== undefined) {
          actionInput.conversationId = selection.conversationId;
        }
        if (activeBot.hostKind === 'local') {
          const deviceId = localHost?.deviceId;
          if (!deviceId) throw new Error(t('本机设备身份未就绪，未提交', 'Local device identity not ready'));
          const env = await BotHost.call({
            method: 'callCapabilityAction',
            params: {
              installationId: selection.installationId,
              action: 'selectGoogleAccount',
              request: {
                requestId: uuid(),
                deviceId,
                botId: activeBot.botId,
                input: actionInput,
              },
            },
          });
          return env?.result;
        }
        const api = remoteClientRef.current?.api;
        const identity = activeBot.remoteIdentity;
        if (!api || !identity || !remoteConnected || activeBot.online === false) {
          throw new Error(t('目标设备离线，未提交', 'Target device offline'));
        }
        return api.call(identity, 'callCapabilityAction', {
          installationId: selection.installationId,
          action: 'selectGoogleAccount',
          request: {
            requestId: uuid(),
            deviceId: identity.targetDeviceId,
            botId: activeBot.botId,
            input: actionInput,
          },
        });
      }
      if (!selection.cancelled && selection.email) {
        const reply = t(`请使用 Google 账号 ${selection.email} 继续处理刚才的请求。`, `Please continue using Google account ${selection.email}.`);
        setChatDraft(previous => previous ? `${previous}\n${reply}` : reply);
      }
      return { selected: selection.email };
    },
    [activeBot, localHost?.deviceId, remoteConnected, t],
  );
  const openBotBrowser = useCallback(() => {
    if (!activeBot) return;
    nav.push({ screen: 'bot-browser', botKey: activeBot.key });
  }, [activeBot, nav]);
  const mobileGoogleContext = useMemo<GoogleChatCardContext | undefined>(() => {
    if (!activeBot) return undefined;
    const brokerApi = remoteClientRef.current?.api ?? null;
    const brokerIdentity = activeBot.remoteIdentity ?? remoteIdentity ?? null;
    return {
      api: brokerApi,
      identity: brokerIdentity,
      deviceId: activeBot.deviceId,
      botId: activeBot.botId,
      botName: activeBot.role,
      hostLabel: activeBot.hostLabel,
      hostPlatform: activeBot.platform,
      isLocalAndroid: activeBot.hostKind === 'local' && !inTauriUi,
      connected: botPanelConnected,
      callGoogleSetup,
      callBrowser,
      onOpenBrowser: openBotBrowser,
      onOpenCapabilities: () => {
        if (remoteConnected && remoteIdentity && (activeBot.hostKind !== 'local' || localHost?.deviceId)) {
          openModelPickerSheet('capabilities');
        } else {
          openCenterSettings();
        }
      },
      onOpenCenterAdmin: () => openInAppCenterAdmin('google'),
      onSelectGoogleAccount: selectGoogleAccount,
    };
  }, [
    activeBot,
    remoteIdentity,
    inTauriUi,
    botPanelConnected,
    callGoogleSetup,
    callBrowser,
    openBotBrowser,
    remoteConnected,
    localHost?.deviceId,
    openInAppCenterAdmin,
    selectGoogleAccount,
  ]);
  const browserTakeoverHint = useMemo(() => {
    const tools = array<Record<string, unknown>>(effectiveChatLive?.tools);
    const activeTakeover = tools.find(slot => {
      const pres = slot?.presentation as Record<string, unknown> | undefined;
      return slot?.status === 'running' && pres?.kind === 'google-browser-takeover';
    });
    if (!activeTakeover) return null;
    return t('Bot 浏览器待接管 · 点击查看', 'Bot browser needs takeover · Tap to open');
  }, [effectiveChatLive?.tools, t]);
  const toolScopeKey = JSON.stringify([botPanelIdentityKey, activeBot?.primaryConversationId, botPanelConnected]);

  useEffect(() => {
    setVaultTargetKey(null);
  }, [screen, botPanelIdentityKey]);

  // @lane-hooks:settings
  // ---
  // @lane-hooks:hub
  // 列表类型筛选：与搜索框同时生效。
  const [hubFilter, setHubFilter] = useState<'all' | 'bots' | 'rooms'>('all');
  const visibleHubItems = useMemo(
    () => hubFilter === 'all'
      ? filteredMixedHubItems
      : filteredMixedHubItems.filter(e => (hubFilter === 'rooms' ? Boolean(e.room) : Boolean(e.bot))),
    [filteredMixedHubItems, hubFilter],
  );
  // ---
  // @lane-hooks:chat
  useEffect(() => {
    setClearConfirmOpen(false);
  }, [screen, activeBotKey]);
  // Merged bottom status bar: render only the single highest-priority notice.
  // Normal pre-LLM admission phases (queued/checking/synchronizing) are reflected via the composer spinner, not text banners.
  const chatConnIssue = !centerConn.ready && Boolean(centerConn.status?.error);
  const chatLoadIssue = Boolean(chatLoadError) && !(centerConn.status?.state === 'disconnected' && centerConn.status.error);
  const chatAdmissionActive = chatTurnAdmission?.phase === 'failed' &&
    (effectiveChatLive !== undefined || (chatPending?.botKey === activeBot?.key &&
      (chatReceipt?.status === undefined || chatReceipt.status === 'queued')));
  const latestTurn = allChatTurns.at(-1);
  const latestTurnHasError = Boolean(latestTurn?.role === 'assistant' && latestTurn.error);
  const submissionHasTurnError = Boolean(
    submission &&
      activeBot &&
      submission.botKey === activeBot.key &&
      allChatTurns.some(turn => turn.role === 'assistant' && Boolean(turn.error) && turn.entryId > submission.afterEntryId),
  );
  const effectiveFailureNotice =
    activityFailure || (!submissionHasTurnError ? submissionFailure : undefined);
  const slotFailureActive =
    !isBotBusy &&
    !recoveringChat &&
    !chatAdmissionActive &&
    !latestTurnHasError &&
    (rawBotActivity.phase === 'failed' || Boolean(effectiveFailureNotice));
  const slotFailure = useMemo(
    () => (slotFailureActive ? { detail: effectiveFailureNotice || undefined } : undefined),
    [slotFailureActive, effectiveFailureNotice],
  );
  const chatStatusKind: 'admission' | 'conn' | 'load' | 'clear' | null =
    chatAdmissionActive ? 'admission'
      : chatConnIssue ? 'conn'
      : chatLoadIssue ? 'load'
      : clearNotice ? 'clear'
      : null;
  const chatAdmissionText = admissionStatusText;
  // ---
  // @lane-hooks:remote-composer
  // ---
  // @lane-hooks:bot-profile
  // 资料页即编辑页：从非资料页家族进入或换 Bot 时预填共享编辑态；
  // 从头像/灵魂/电脑等子页返回不重填，保住未保存的输入。
  useLayoutEffect(() => {
    const inFamily =
      screen === 'bot-profile' ||
      screen === 'bot-profile-manage' ||
      screen === 'bot-avatar' ||
      screen === 'bot-soul' ||
      screen === 'bot-schedules' ||
      screen === 'bot-screen' ||
      screen === 'bot-browser' ||
      screen === 'bot-skills' ||
      (screen === 'settings-center-admin' && nav.previous?.screen === 'bot-profile');
    const key = activeBot?.key ?? null;
    const previous = profileEditKeyRef.current;
    if (previous.key !== key || previous.inFamily !== inFamily) {
      profileEditKeyRef.current = { key, inFamily };
    }
    if (screen === 'bot-profile' && activeBot && (!previous.inFamily || previous.key !== key)) {
      prefillBotProfileEdit(activeBot);
    }
    if (screen === 'bot-profile' && restoreProfileManageFocus.current) {
      restoreProfileManageFocus.current = false;
      profileManageTrigger.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, activeBot?.key, nav.previous?.screen]);
  // ---
  // @lane-hooks:avatar-soul
  const soulDraftBytes = soulBytes(soulDraft);
  const soulByteRatio = soulDraftBytes / SOUL_MAX_BYTES;
  // 与 botSoul 文本一致即视为已保存；加载中（null）时先看本地脏标记。
  const soulSaved = botSoul ? soulDraft === botSoul.text : !soulDirty;
  const connectedToCenter = Boolean(centerConn.ready && remoteConnected && remoteIdentity?.kind !== 'local');
  const activeBotModelSummary = useMemo(
    () => (activeBot ? formatBotModelSummary(activeBot, { connectedToCenter }) : null),
    [activeBot, connectedToCenter],
  );
  // ---
  // @lane-hooks:errors
  // ---
  // @lane-hooks:schedules
  // ---
  // @lane-hooks:scopes
  const navigateFromSidebar = (next: RootScreen) => {
    if (screen === 'tasks' && next !== 'tasks') {
      if (globalTasks.createDraft.trim()) globalTasks.markDraftLeftUnpublished();
      setCreatingTask(false);
      setTaskInitialEditMode(false);
    }
    setLeftDrawerOpen(false);
    nav.resetTo(next === 'settings' ? { screen: 'settings', settingsPage: 'overview' } : { screen: next });
  };
  // ---

  return (
    <div
      className={`bot-hub-shell${screen === 'bot-screen' || screen === 'bot-browser' ? ' is-fullscreen-computer' : ''}`}
    >
      <MobileClientUpdatePrompt active={active} onOpenUpdates={() => {
        navigateFromSidebar('settings');
        nav.push({ screen: 'settings', settingsPage: 'updates' });
      }} />
      <Dialog
        open={leftDrawerOpen}
        onOpenChange={setLeftDrawerOpen}
        title="PiBot"
        drawer
        className="hub-navigation"
        onCloseAutoFocus={event => {
          event.preventDefault();
          navigationTriggerRef.current?.focus();
        }}
      >
        <nav className="hub-left-drawer-nav" aria-label={t('主导航', 'Main navigation')}>
          {([
            { screen: 'hub', label: t('对话', 'Chats'), Icon: MessageSquare },
            { screen: 'tasks', label: t('任务', 'Tasks'), Icon: ClipboardCheck },
            { screen: 'board', label: t('看板', 'Board'), Icon: LayoutDashboard },
          ] as const).map(item => (
            <button
              key={item.screen}
              type="button"
              className="hub-left-nav-btn"
              aria-current={screen === item.screen ? 'page' : undefined}
              onClick={() => navigateFromSidebar(item.screen)}
            >
              <item.Icon size={20} aria-hidden />
              <span>{item.label}</span>
              {item.screen === 'tasks' && globalTasks.waitingCount > 0 ? (
                <span className="hub-left-nav-badge">
                  {globalTasks.waitingCount}
                </span>
              ) : null}
              <ChevronRight size={16} className="hub-left-nav-chevron" aria-hidden />
            </button>
          ))}
        </nav>
        <div className="hub-left-drawer-spacer" />
        <footer className="hub-left-drawer-footer">
          <Button
            variant="ghost"
            fullWidth
            leadingIcon={<Settings size={20} />}
            className="hub-left-settings-btn"
            aria-current={screen === 'settings' ? 'page' : undefined}
            onClick={() => navigateFromSidebar('settings')}
          >
            {t('设置', 'Settings')}
          </Button>
        </footer>
      </Dialog>
      {/* ==================== SCREEN 1: MAIN HUB (15844.jpg + PanelLeft icon) ==================== */}
      {/* 群聊/私聊子页打开时保持 hub DOM（隐藏不卸载）：返回来源滚动位置不丢。
          用显式 class 而非 hidden 属性，避免 author CSS display 覆盖。 */}
      {screen === 'tasks' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%' }}>
          {taskBoardNotice && (
            <ErrorNotice error={taskBoardNotice} compact onDismiss={() => setTaskBoardNotice('')} />
          )}
          <TaskBoardView
            variant="mobile"
            controller={globalTasks}
            bots={taskBotOptions}
            activeTaskId={activeTaskId}
            creatingTask={creatingTask}
            initialEditMode={taskInitialEditMode}
            onOpenCreate={() => {
              setTaskBoardNotice('');
              setCreatingTask(true);
              setActiveTaskId(null);
              setTaskInitialEditMode(false);
            }}
            onCloseCreate={() => {
              if (globalTasks.createDraft.trim()) globalTasks.markDraftLeftUnpublished();
              setCreatingTask(false);
            }}
            onSelectTask={(taskId, openInEditMode) => {
              setTaskBoardNotice('');
              setCreatingTask(false);
              setActiveTaskId(taskId);
              setTaskInitialEditMode(Boolean(openInEditMode));
            }}
            onOpenMobileDrawer={() => setLeftDrawerOpen(true)}
            onJumpToChat={({ deviceId, botId, taskId, stepId }) => {
              const hasDeviceId = Boolean(deviceId && deviceId.trim());
              const targetBot = hasDeviceId
                ? (allBotItems.find((b) => !b.archivedAt && b.deviceId === deviceId && b.botId === botId) ??
                  allBotItems.find((b) => b.deviceId === deviceId && b.botId === botId))
                : (allBotItems.find((b) => !b.archivedAt && b.botId === botId) ??
                  allBotItems.find((b) => b.botId === botId));
              if (!targetBot) {
                setTaskBoardNotice(
                  hasDeviceId
                    ? t(`目标 Bot 不可用（设备 ${deviceId} · ${botId} 不在当前目录中）`, `Target bot unavailable (${deviceId} / ${botId} not found)`)
                    : t(`目标 Bot 不可用（${botId} 不在当前目录中）`, `Target bot unavailable (${botId} not found)`),
                );
                return;
              }
              setTaskBoardNotice('');
              setJumpedTaskQuote({
                deviceId: targetBot.deviceId,
                botId: targetBot.botId,
                taskId,
                stepId: stepId ?? null,
              });
              setTaskReturnId(taskId);
              openBotChat(targetBot, 'tasks');
            }}
          />
        </div>
      )}
      {screen === 'board' && <BotBoard
        targets={boardTargets}
        board={board}
        loading={hubRefreshing || (!localBotsLoaded && localHost?.phase === 'running')}
        error={directoryError}
        onOpenMobileDrawer={() => setLeftDrawerOpen(true)}
        onBack={() => nav.resetTo({ screen: 'hub' })}
        onOpenTask={(taskId) => {
          setActiveTaskId(taskId);
          setCreatingTask(false);
          setTaskInitialEditMode(false);
          nav.push({ screen: 'tasks', taskId });
        }}
        onOpen={target => {
          const bot = allBotItems.find(bot => botBoardKey(pinStorageScope, bot.deviceId, bot.botId) === target.key);
          if (bot) openBotChat(bot, 'board');
        }}
      />}
      {screen === 'chat' && board.storageError && <p role="alert" className="bot-board-warning">{board.storageError}</p>}
      {(screen === 'hub' || screen === 'chat' || screen === 'conversation' || screen === 'dm' || screen === 'group-create') && (
        <HubScreen
          visible={screen === 'hub'}
          anyDrawerOpen={anyDrawerOpen}
          leftDrawerOpen={leftDrawerOpen}
          navigationTriggerRef={navigationTriggerRef}
          onOpenLeftDrawer={() => setLeftDrawerOpen(true)}
          hubRefreshing={hubRefreshing}
          pullDistance={pullDistance}
          pullThreshold={PULL_THRESHOLD}
          hubAddMenuOpen={hubAddMenuOpen}
          onToggleHubAddMenu={() => setHubAddMenuOpen(v => !v)}
          onCloseHubAddMenu={() => setHubAddMenuOpen(false)}
          onOpenCreateBot={openCreateBotPage}
          onOpenCreateGroup={openCreateGroupPage}
          hubScrollRef={hubScrollRef}
          onTouchStart={onHubScrollTouchStart}
          onTouchMove={onHubScrollTouchMove}
          onTouchEnd={onHubScrollTouchEnd}
          onTouchCancel={() => { pullTouchRef.current = null; setPullDistance(0); }}
          primaryBot={primaryBot}
          primaryPreset={primaryPreset}
          onOpenPrimaryCreate={() => {
            void (async () => {
              const snap = await ensureLocalHostRunning();
              const bots = snap?.phase === 'running' ? await syncLocalBots(snap) : [];
              if (!bots.some(b => b.isPrimary && !b.archivedAt)) {
                openCreateBotPage(true);
              }
            })();
          }}
          botIsOffline={botIsOffline}
          onOpenBotChat={bot => openBotChat(bot, 'hub')}
          onOpenContextMenu={setHubContextMenu}
          hubFilter={hubFilter}
          onChangeHubFilter={setHubFilter}
          directoryError={directoryError}
          chatPinsError={chatPins.error}
          actionError={action.error}
          onDismissDirectoryError={() => setDirectoryError('')}
          onDismissActionError={() => action.setError('')}
          onOpenCenterSettings={openCenterSettings}
          onTriggerRefresh={() => void triggerHubRefresh()}
          hasRemoteBots={remoteBots.length > 0}
          remoteConnected={remoteConnected}
          hasLocalHost={Boolean(localHost)}
          roomConversationsError={roomConversationsError}
          roomConversationsLoaded={roomConversationsLoaded}
          roomConversationsLoading={roomConversationsLoading}
          onRefreshRoomConversations={() => refreshRoomConversations()}
          visibleHubItems={visibleHubItems}
          visiblePinnedKeys={visiblePinnedKeys}
          onReorderPinnedKeys={handleReorderPinnedKeys}
          unreadConversationKeys={unreadConversationKeys}
          knownBots={knownBots}
          onOpenScopeConversation={openScopeConversation}
          botMetaMap={botMetaMap}
          clearedMap={clearedMap}
          scopeForBot={scopeForBot}
          searchQuery={searchQuery}
          onChangeSearchQuery={setSearchQuery}
        />
      )}

      {/* ==================== SCREEN 2: BOT CHAT VIEW (15845.jpg) ==================== */}
      {/* dm 子页从聊天进入时保持 chat DOM（隐藏不卸载）：返回主聊天滚动位置不丢。 */}
      {(screen === 'chat' || (screen === 'dm' && nav.previous?.screen === 'chat')) && activeBot && (
        <ChatScreen
          visible={screen === 'chat'}
          anyDrawerOpen={anyDrawerOpen}
          activeBot={activeBot}
          activeChatScope={activeChatScope}
          hasRemoteConfigured={hasRemoteConfigured}
          remoteConnected={remoteConnected}
          activeBotModelSummary={activeBotModelSummary}
          coarsePointer={coarsePointer}
          inTauriUi={inTauriUi}
          collapseToolOutput={collapseToolOutput}
          hideToolOutput={hideToolOutput}
          botPanelConnected={botPanelConnected}
          toolScopeKey={toolScopeKey}
          action={action}
          chatTopMenuOpen={chatTopMenuOpen}
          onToggleChatTopMenu={() => setChatTopMenuOpen(v => !v)}
          onCloseChatTopMenu={() => setChatTopMenuOpen(false)}
          onBack={() => {
            if (!popScreen()) nav.resetTo({ screen: 'hub' });
          }}
          onOpenBotProfile={openBotProfile}
          onOpenBotDmList={openBotDmList}
          onSetPrimaryBot={bot => void handleSetPrimaryBot(bot)}
          onRequestArchiveBot={requestArchiveBot}
          onUnarchiveBot={bot => void handleUnarchiveBot(bot)}
          onRequestDeleteBot={requestDeleteBot}
          onOpenClearConfirm={() => setClearConfirmOpen(true)}
          chatSearchOpen={chatSearchOpen}
          chatSearchQuery={chatSearchQuery}
          chatSearchActive={chatSearchActive}
          onToggleChatSearch={() => setChatSearchOpen(v => !v)}
          onChangeChatSearchQuery={setChatSearchQuery}
          onCloseChatSearch={() => {
            setChatSearchOpen(false);
            setChatSearchQuery('');
          }}
          chatScrollRef={chatScrollRef}
          onMessagesScroll={e => {
            const el = e.currentTarget;
            const nearBottom = isNearChatBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
            if (nearBottom) {
              chatJumpingToBottomRef.current = false;
              if (chatJumpTimerRef.current !== null) {
                window.clearTimeout(chatJumpTimerRef.current);
                chatJumpTimerRef.current = null;
              }
              chatStickToBottomRef.current = true;
              setChatHasNewContent(prev => (prev ? false : prev));
            } else if (!chatJumpingToBottomRef.current) {
              chatStickToBottomRef.current = false;
            }
          }}
          onCancelJumpToBottom={() => {
            if (chatJumpingToBottomRef.current) chatJumpingToBottomRef.current = false;
          }}
          chatHistoryLoading={chatHistoryLoading}
          visibleTurns={visibleTurns}
          latestTurn={latestTurn}
          latestTurnHasError={latestTurnHasError}
          activeEditing={activeEditing}
          canEditHistoryTurn={canEditHistoryTurn}
          isBotBusy={isBotBusy}
          rawBotActivity={rawBotActivity}
          botActivity={botActivity}
          sendingOptimistic={sendingOptimistic}
          sendingReceipt={sendingReceipt}
          displayGeneratingText={displayGeneratingText}
          displayLiveToolName={displayLiveToolName}
          activityFailure={activityFailure}
          effectiveFailureNotice={effectiveFailureNotice}
          activeTurnStartedAt={activeTurnStartedAt}
          slotFailure={slotFailure}
          effectiveChatLive={effectiveChatLive}
          chatPending={chatPending}
          chatReceipt={chatReceipt}
          receiptUserCancelled={receiptUserCancelled}
          submissionInCurrentEpoch={submissionInCurrentEpoch}
          chatTurnAdmission={chatTurnAdmission}
          chatStatusKind={chatStatusKind}
          chatAdmissionText={chatAdmissionText}
          chatLoadError={chatLoadError}
          clearNotice={clearNotice}
          chatHasNewContent={chatHasNewContent}
          onJumpToLatest={jumpToLatestMessages}
          onOpenLearnedSkills={() => nav.push({ screen: 'bot-skills', botKey: activeBot.key })}
          onOpenCenterSettings={openCenterSettings}
          turnAttachmentFetcher={
            activeBot.hostKind === 'remote' && activeBot.remoteIdentity && remoteClientRef.current
              ? remoteAttachmentFetcher(remoteClientRef.current.api, activeBot.remoteIdentity, activeBot.botId)
              : localAttachmentFetcher
          }
          onStartEditTurn={turn => {
            setBubbleActionTurn(null);
            setComposerImageError('');
            setEditingTurn({
              botKey: activeBot.key,
              scopeKey: activeChatScope,
              entryId: turn.entryId,
              text: turn.text,
              attachments: turn.attachments ? turn.attachments.map(a => ({ ...a })) : [],
            });
            requestAnimationFrame(() => composerTextareaRef.current?.focus());
          }}
          onOpenBubbleActions={setBubbleActionTurn}
          onSubmitQuestionnaire={submitQuestionnaire}
          onSubmitVaultUnlock={submitVaultUnlock}
          googleContext={mobileGoogleContext}
          currentGoogleSetup={currentGoogleSetup}
          onOpenBrowser={openBotBrowser}
          browserTakeoverHint={browserTakeoverHint}
          canStopBot={canStopBot}
          isStoppingBot={isStoppingBot}
          queueActionBusy={queueActionBusy}
          stopError={stopError}
          onClearStopError={() => setStopError('')}
          onRetryAdmission={() => void retryAdmission()}
          onRetryRemoteAdmission={() => void retryRemoteAdmission()}
          onRestoreFailedAdmission={requestId => void restoreFailedAdmission(requestId)}
          onStopBot={bot => {
            setStopError('');
            requestStopBot(bot).then(
              () => setStopError(''),
              error => setStopError(errorText(error)),
            );
          }}
          taskScopeKey={taskScopeKey}
          taskActionFailures={taskActionFailures}
          retryingTaskActionKey={retryingTaskActionKey}
          onRetryTaskChatAction={failure => void retryTaskChatAction(failure)}
          onDismissTaskChatAction={dismissTaskChatAction}
          activeBotTaskContext={activeBotTaskContext}
          taskBotOptions={taskBotOptions}
          taskBannerBusy={taskBannerBusy}
          onOpenTaskDetail={(tid, openEdit) => {
            setActiveTaskId(tid);
            setCreatingTask(false);
            setTaskInitialEditMode(Boolean(openEdit));
            nav.push({ screen: 'tasks', taskId: tid });
          }}
          onConfirmTaskPlanFromTurn={async tid => {
            const target = effectiveGlobalTasks.find(item => item.id === tid);
            await executeTaskChatAction({
              kind: 'confirm_plan',
              scopeKey: taskScopeKey,
              botKey: `${activeBot.deviceId}:${activeBot.botId}`,
              taskId: tid,
              taskTitle: target?.title ?? tid,
            });
          }}
          onAnswerTaskPromptFromTurn={async (tid, answer) => {
            const target = effectiveGlobalTasks.find(item => item.id === tid);
            await executeTaskChatAction({
              kind: 'answer_prompt',
              scopeKey: taskScopeKey,
              botKey: `${activeBot.deviceId}:${activeBot.botId}`,
              taskId: tid,
              taskTitle: target?.title ?? tid,
              answer,
            });
          }}
          onConfirmTaskPlanFromBanner={async tid => {
            setTaskBannerBusy(true);
            try {
              const target = effectiveGlobalTasks.find(item => item.id === tid);
              await executeTaskChatAction({
                kind: 'confirm_plan',
                scopeKey: taskScopeKey,
                botKey: `${activeBot.deviceId}:${activeBot.botId}`,
                taskId: tid,
                taskTitle: target?.title ?? tid,
              });
            } finally {
              setTaskBannerBusy(false);
            }
          }}
          onAnswerTaskPromptFromBanner={async (tid, answer) => {
            setTaskBannerBusy(true);
            try {
              const target = effectiveGlobalTasks.find(item => item.id === tid);
              await executeTaskChatAction({
                kind: 'answer_prompt',
                scopeKey: taskScopeKey,
                botKey: `${activeBot.deviceId}:${activeBot.botId}`,
                taskId: tid,
                taskTitle: target?.title ?? tid,
                answer,
              });
            } finally {
              setTaskBannerBusy(false);
            }
          }}
          onClearJumpedTaskQuote={() => setJumpedTaskQuote(null)}
          onCycleWaitingTask={() => {
            const botKey = `${activeBot.deviceId}:${activeBot.botId}`;
            setJumpedTaskQuote(null);
            setWaitingTaskOffsetByBot(prev => ({ ...prev, [botKey]: (prev[botKey] ?? 0) + 1 }));
          }}
          offlineNotice={offlineNotice}
          onDismissOfflineNotice={() => setOfflineNotice(undefined)}
          onShowOfflineNotice={text => setOfflineNotice({ botKey: activeBot.key, text })}
          remoteApi={remoteClientRef.current?.api ?? null}
          chatDraft={chatDraft}
          slashBusy={slashBusy}
          composerMenuOpen={composerMenuOpen}
          onToggleComposerMenu={() => setComposerMenuOpen(v => !v)}
          onCloseComposerMenu={() => setComposerMenuOpen(false)}
          onChangeEditTurn={patch => setEditingTurn(prev => (prev ? { ...prev, ...patch } : null))}
          onCancelEditTurn={() => setEditingTurn(null)}
          onSubmitEditedTurn={() => void submitEditedTurn()}
          onRunSlashCommand={runSlashCommand}
          onAbortRemote={async () => {
            await requestStopBot(activeBot);
          }}
          onRemoteFallbackTransferred={() => {
            if (currentChatScope.current === activeChatScope) {
              setChatDraft('');
              setChatDraftAttachments([]);
              setComposerImageError('');
            }
            writeChatDraft(activeChatScope, '');
            writeChatDraftAttachments(activeChatScope, []);
          }}
          onRemoteStarted={(requestId, text, draft, delivery) => {
            const old = pendingByBot.current.get(activeChatScope)?.pending;
            const attachmentIds = draft.attachments?.map(a => a.id).filter(Boolean);
            const pending: ChatPending = old?.requestId === requestId ? old : {
              botKey: activeBot.key, scopeKey: activeChatScope, requestId, text, draft,
              ...(attachmentIds?.length ? { attachments: attachmentIds } : {}),
              ...(delivery ? { delivery } : {}),
              phase: 'sending',
              submittedAt: Date.now(),
              afterEntryId: Math.max(maxHistoryEntryId(chatHistory), Number(effectiveChatLive?.lastEntryId) || 0, getCutoff(activeBot.key, activeChatScope)),
            };
            if (currentChatScope.current === activeChatScope) chatSubmissionRef.current = pending;
            const entry = pendingByBot.current.get(activeChatScope);
            updatePending({ pending, receipt: entry?.pending.requestId === requestId ? entry.receipt : undefined }, false);
          }}
          onRemotePersist={requestId => {
            const entry = pendingByBot.current.get(activeChatScope);
            return Boolean(activeChatScope && entry?.pending.requestId === requestId && updatePending(entry));
          }}
          onRemoteQueued={(requestId, pendingId) => {
            const entry = pendingByBot.current.get(activeChatScope);
            if (entry?.pending.requestId === requestId) updatePending({ ...entry, pending: { ...entry.pending, pendingId } });
          }}
          onRemoteAccepted={receipt => {
            const entry = pendingByBot.current.get(activeChatScope);
            if (entry?.pending.requestId === receipt.requestId) updatePending({ pending: { ...entry.pending, phase: 'accepted', admission: (receipt as TurnAdmissionCarrier).admission ?? null }, receipt });
          }}
          onRemoteUnconfirmed={requestId => {
            const entry = pendingByBot.current.get(activeChatScope);
            if (entry?.pending.requestId === requestId && !entry.receipt) updatePending({ ...entry, pending: { ...entry.pending, phase: 'recovering' } });
          }}
          onRemoteNotSent={requestId => removePending(activeChatScope, requestId)}
          onForceScrollBottom={forceChatScrollBottom}
          pendingRemoteQuote={pendingRemoteQuote}
          onConsumedRemoteQuote={() => setPendingRemoteQuote(null)}
          onTaskMessageSent={(rawText, capturedTaskContext) => {
            if (!rawText) return;
            handleTaskMessageAccepted(
              capturedTaskContext?.linkedTask ?? activeBotLinkedTask,
              rawText,
              {
                deviceId: capturedTaskContext?.deviceId ?? activeBot.deviceId,
                botId: capturedTaskContext?.botId ?? activeBot.botId,
                role: capturedTaskContext?.botRole ?? activeBot.role,
              },
              capturedTaskContext?.scopeKey ?? taskScopeKey,
            );
          }}
          slash={slash}
          composerImageError={composerImageError}
          onDismissComposerImageError={() => setComposerImageError('')}
          imageUploading={imageUploading}
          onPickLocalImages={pickLocalImages}
          localQueuedStripItems={localQueuedStripItems}
          canSteerLocal={canSteerLocal}
          onRecallLocalQueuedItem={(item, mergeIntoDraft) => void recallLocalQueuedItem(item, mergeIntoDraft)}
          onRecallAllLocalQueued={() => void recallAllLocalQueued()}
          onSteerLocalQueuedItem={item => void steerLocalQueuedItem(item)}
          editSubmitting={editSubmitting}
          effectiveLocalDraft={effectiveLocalDraft}
          effectiveLocalAttachments={effectiveLocalAttachments}
          localAttachmentFetcher={localAttachmentFetcher}
          onRemoveLocalAttachment={index => {
            if (activeEditing) {
              setEditingTurn(prev => (prev ? { ...prev, attachments: prev.attachments.filter((_, i) => i !== index) } : null));
            } else {
              const next = chatDraftAttachments.filter((_, i) => i !== index);
              setChatDraftAttachments(next);
              if (currentChatScope.current && !writeChatDraftAttachments(currentChatScope.current, next)) {
                setClearNotice(t('草稿未能保存，请保持页面打开。', 'Draft could not be saved; keep this page open.'));
              }
            }
          }}
          onChangeLocalDraft={val => {
            if (activeEditing) {
              setEditingTurn(prev => (prev ? { ...prev, text: val } : null));
            } else {
              setChatDraft(val);
              if (currentChatScope.current && !writeChatDraft(currentChatScope.current, val)) {
                setClearNotice(t('草稿未能保存，请保持页面打开。', 'Draft could not be saved; keep this page open.'));
              }
            }
          }}
          composerTextareaRef={composerTextareaRef}
          voiceCapturing={voiceCapturing}
          voicePartialText={voicePartialText}
          voiceLevel={voiceLevel}
          onToggleVoiceCapture={() =>
            action.run(async () => {
              if (voiceCapturing) {
                try {
                  await BotHost.finishVoice();
                } finally {
                  updateVoiceCapturing(undefined);
                  setVoicePartialText('');
                  setVoiceLevel(0);
                }
              } else {
                const submission = {
                  botKey: activeBot.key,
                  requestId: uuid(),
                  afterEntryId: Math.max(
                    maxHistoryEntryId(chatHistory),
                    Number(effectiveChatLive?.lastEntryId) || 0,
                    getCutoff(activeBot.key, activeChatScope),
                  ),
                };
                chatSubmissionRef.current = submission;
                setChatReceipt(undefined);
                const snap = await ensureLocalHostRunning();
                if (!snap || snap.phase !== 'running' || chatSubmissionRef.current !== submission) return;
                const targetBotId = activeBot.botId;
                const cap = { botId: targetBotId, requestId: submission.requestId };
                setVoicePartialText('');
                setVoiceLevel(0);
                updateVoiceCapturing(cap);
                try {
                  await BotHost.startVoice(cap);
                } catch (err) {
                  updateVoiceCapturing(undefined);
                  setVoicePartialText('');
                  setVoiceLevel(0);
                  throw err;
                }
              }
            })
          }
          isPreLlmChat={isPreLlmChat}
          isStoppingChat={isStoppingChat}
          isLlmRunningChat={isLlmRunningChat}
          showLocalComposerStop={showLocalComposerStop}
          isDeletingActiveBot={deletingBots.current.has(activeBot.key)}
          onSendMessage={delivery => void sendMessage(delivery)}
        />
      )}

      {/* ==================== SCREEN 3: BOT PROFILE VIEW (15867.jpg) ==================== */}
      {screen === 'bot-profile' && activeBot && (() => {
        const canOpenRemoteBotConfig = Boolean(
          getOrCreateRemoteClient &&
          remoteConnected &&
          remoteIdentity &&
          (activeBot.hostKind !== 'local' || localHost?.deviceId),
        );
        return (
          <BotProfileScreen
            activeBot={activeBot}
            editName={editName}
            onChangeEditName={setEditName}
            editSubtitle={editSubtitle}
            onChangeEditSubtitle={setEditSubtitle}
            profileError={editSaveErrors.profile}
            onDismissProfileError={() => setEditSaveErrors(errors => ({ ...errors, profile: '' }))}
            actionBusy={action.busy}
            canOpenRemoteBotConfig={canOpenRemoteBotConfig}
            connectedToCenter={connectedToCenter}
            activeBotModelSummary={activeBotModelSummary}
            scheduleCount={botMetaMap[activeBot.key]?.scheduleCount ?? 0}
            isBotBusy={isBotBusy}
            profileManageTriggerRef={profileManageTrigger}
            onBack={closeBotProfile}
            onSave={() => void handleSaveBotEdit('profile')}
            onOpenAvatarPicker={openAvatarPicker}
            onOpenModelSettings={() => (canOpenRemoteBotConfig ? openModelPickerSheet('model') : openCenterSettings())}
            onOpenSoul={() => nav.push({ screen: 'bot-soul', botKey: activeBot.key })}
            onOpenSkills={() => nav.push({ screen: 'bot-skills', botKey: activeBot.key })}
            onOpenCapabilities={() => (canOpenRemoteBotConfig ? openModelPickerSheet('capabilities') : openCenterSettings())}
            onOpenSchedules={() => openBotSchedules(activeBot)}
            onOpenVault={() => setVaultTargetKey(botPanelIdentityKey)}
            onOpenComputer={() => nav.push({ screen: 'bot-screen', botKey: activeBot.key })}
            onOpenBrowser={openBotBrowser}
            onOpenManage={() => nav.push({ screen: 'bot-profile-manage', botKey: activeBot.key })}
          />
        );
      })()}

      {screen === 'bot-profile-manage' && activeBot && (
        <BotProfileManageScreen
          activeBot={activeBot}
          connectedToCenter={connectedToCenter}
          editCwd={editCwd}
          editCwdBaseline={editCwdBaseline}
          editCwdRevision={editCwdRevision}
          editCwdError={editCwdError}
          editCwdSaved={editCwdSaved}
          cwdSaveError={editSaveErrors.cwd}
          onChangeEditCwd={val => {
            editCwdDirtyRef.current = true;
            setEditCwd(val);
            setEditCwdSaved(false);
          }}
          onReloadEditCwd={() => void loadEditCwd(activeBot)}
          onSaveEditCwd={() => void handleSaveBotEdit('cwd')}
          onDismissCwdSaveError={() => setEditSaveErrors(errors => ({ ...errors, cwd: '' }))}
          onOpenCenterSettings={openCenterSettings}
          action={action}
          onBack={backFromProfileManage}
          onSetPrimary={bot => void handleSetPrimaryBot(bot)}
          onRequestArchive={requestArchiveBot}
          onUnarchive={bot => void handleUnarchiveBot(bot)}
          onRequestDelete={requestDeleteBot}
        />
      )}

      {/* ==================== SCREEN 3B: FULL-SCREEN COMPUTER VIEW (15859.jpg) ==================== */}
      {screen === 'bot-screen' && activeBot && (
        <BotScreenPanel
          key={showerPreviewKey}
          botId={activeBot.botId}
          botName={activeBot.role}
          hostLabel={activeBot.hostKind === 'remote' ? `${t('远程', 'Remote')} · ${activeBot.hostLabel}` : activeBot.hostLabel}
          avatarPreset={resolveBotAvatarPreset(botAvatarKey(activeBot), activeBot.role, activeBot.isPrimary)}
          isPrimary={activeBot.isPrimary}
          hostKind={activeBot.hostKind}
          open={screen === 'bot-screen'}
          onBack={() => {
            if (!popScreen()) nav.push({ screen: 'bot-profile', botKey: activeBot.key });
          }}
          showerTarget={showerTarget}
          showerCall={showerCall}
          showerConnected={showerConnected}
          onInterrupt={async () => {
            if (activeBot.hostKind === 'local') {
              await BotHost.call({ method: 'abort', params: { botId: activeBot.botId } });
            }
          }}
        />
      )}

      {/* ==================== SCREEN 3C: FULL-SCREEN BOT BROWSER VIEW ==================== */}
      {screen === 'bot-google-setup' && activeBot && (
        <SettingsSheet title={t('Google 配置向导', 'Google setup wizard')} onClose={() => { popScreen(); }}>
          <GoogleSetupWizard
            key={activeBot.key}
            api={mobileGoogleContext?.api}
            identity={mobileGoogleContext?.identity}
            botId={activeBot.botId}
            botName={activeBot.role}
            isLocalAndroid={activeBot.hostKind === 'local' || activeBot.platform?.toLowerCase() === 'android'}
            autoStart
            callGoogleSetup={callGoogleSetup}
            onOpenBrowser={openBotBrowser}
            onOpenCenterAdmin={() => openInAppCenterAdmin('google')}
            onClose={() => { popScreen(); }}
          />
        </SettingsSheet>
      )}

      {screen === 'bot-browser' && activeBot && (
        <div className="gws-mobile-browser-screen">
          <BotBrowserPanel
            key={`${showerPreviewKey}:browser:${activeBot.botId}`}
            botId={activeBot.botId}
            deviceId={activeBot.deviceId}
            botName={activeBot.role}
            hostLabel={activeBot.hostKind === 'remote' ? `${t('远程', 'Remote')} · ${activeBot.hostLabel}` : activeBot.hostLabel}
            mode="fullscreen"
            connected={botPanelConnected}
            request={callBrowser}
            onSwitchToExternalGuide={url => {
              void callGoogleSetup({ action: 'resume', mode: 'guide-browser' }).catch(() => {});
              if (url) void openExternalUrl(url).catch(() => {});
            }}
            onOpenSystemGoogleAuth={() => openInAppCenterAdmin('google')}
            onClose={() => {
              if (!popScreen()) nav.push({ screen: 'chat', botKey: activeBot.key });
            }}
          />
        </div>
      )}

      {/* ==================== SCREEN 4: CREATE BOT VIEW (15847.jpg) ==================== */}
      {screen === 'bot-edit' && (
        <CreateBotScreen
          mustCreatePrimaryBot={mustCreatePrimaryBot}
          editMakePrimary={editMakePrimary}
          onChangeMakePrimary={setEditMakePrimary}
          editName={editName}
          onChangeName={setEditName}
          editSubtitle={editSubtitle}
          onChangeSubtitle={setEditSubtitle}
          editCwd={editCwd}
          onChangeCwd={val => {
            editCwdDirtyRef.current = true;
            setEditCwd(val);
          }}
          editTargetHost={editTargetHost}
          onChangeTargetHost={val => {
            setEditTargetHost(val);
            editCwdDirtyRef.current = false;
            setEditCwd('');
          }}
          editAvatarPreset={editAvatarPreset}
          editModelRef={editModelRef}
          onChangeModelRef={setEditModelRef}
          createAttempt={createAttempt}
          onReconcileCreateAttempt={() => {
            if (!createAttempt) return;
            void action.run(async () => {
              let found: unknown;
              if (createAttempt.target === 'local') {
                const snap = await ensureLocalHostRunning();
                if (!snap || snap.phase !== 'running') throw new Error('Host unavailable');
                found = (
                  await BotHost.call({
                    method: 'findByRequest',
                    params: { requestId: createAttempt.requestId },
                  })
                ).result;
                if (found) await syncLocalBots(snap);
              } else {
                const api = remoteClientRef.current?.api;
                if (
                  !api ||
                  !api.transportConnected ||
                  api.identity?.profileId !== createAttempt.profileId
                ) {
                  throw new Error('Original connection unavailable');
                }
                found = await api.call(
                  api.identityForTarget(createAttempt.target),
                  'findByRequest',
                  { requestId: createAttempt.requestId },
                );
                if (found) await syncRemoteBots();
              }
              if (!found) {
                throw new Error(t('尚未找到原请求，保持原 ID，不能重新创建', 'Original request not found; retain its ID and do not recreate'));
              }
              setCreateAttempt(null);
              nav.resetTo({ screen: 'hub' });
            });
          }}
          onClearCreateAttempt={() => setCreateAttempt(null)}
          hasRemoteConfigured={hasRemoteConfigured}
          localDeviceId={localHost?.deviceId}
          remoteDevices={remoteDevices}
          remoteConnected={remoteConnected}
          createModelPicker={createModelPicker}
          createModelLoading={createModelLoading}
          action={action}
          primaryBackNotice={primaryBackNotice}
          onDismissPrimaryBackNotice={() => setPrimaryBackNotice(null)}
          onBack={() => {
            if (!popScreen()) nav.resetTo({ screen: 'hub' });
          }}
          onSave={() => void handleSaveBotEdit()}
          onOpenAvatarPicker={openAvatarPicker}
        />
      )}

      {/* ==================== SCREEN 4B: CREATE GROUP CHAT VIEW ==================== */}
      {screen === 'group-create' && (
        <CreateGroupScreen
          allBotItems={allBotItems}
          groupTitle={groupTitle}
          onChangeGroupTitle={val => {
            setGroupCreateError('');
            setGroupTitle(val);
          }}
          groupMembers={groupMembers}
          groupSearchQuery={groupSearchQuery}
          onChangeGroupSearchQuery={setGroupSearchQuery}
          groupCreating={groupCreating}
          groupCreateError={groupCreateError}
          onDismissGroupCreateError={() => setGroupCreateError('')}
          groupCreateAttempt={groupCreateAttempt}
          onDiscardGroupCreateAttempt={discardGroupCreateAttempt}
          onToggleGroupMember={toggleGroupMember}
          botIsOffline={botIsOffline}
          onBack={() => {
            if (!popScreen()) nav.resetTo({ screen: 'hub' });
          }}
          onCreateGroup={() => void handleCreateGroup()}
          onOpenCreateBot={() => openCreateBotPage(false)}
        />
      )}

      {/* ==================== SCREEN 5: AVATAR PICKER VIEW (15848.jpg) ==================== */}
      {screen === 'bot-avatar' && (
        <BotAvatarScreen
          activeBot={activeBot}
          avatarTab={avatarTab}
          onChangeAvatarTab={setAvatarTab}
          draftAvatar={draftAvatar}
          setDraftAvatar={setDraftAvatar}
          action={action}
          onBack={() => {
            if (!popScreen()) nav.resetTo({ screen: 'hub' });
          }}
          onDone={() =>
            void action.run(async () => {
              setEditAvatarPreset(draftAvatar);
              if (nav.previous?.screen === 'bot-profile' && activeBot) {
                await saveAvatar(activeBot, draftAvatar);
              }
              if (!popScreen()) nav.resetTo({ screen: 'hub' });
            })
          }
        />
      )}

      {/* ==================== SCREEN 6: SOUL DOCUMENT EDITOR (SOUL.md) ==================== */}
      {screen === 'bot-soul' && (
        <BotSoulScreen
          activeBot={activeBot}
          soulDraft={soulDraft}
          setSoulDraft={setSoulDraft}
          soulDirty={soulDirty}
          setSoulDirty={setSoulDirty}
          soulSaved={soulSaved}
          soulDraftBytes={soulDraftBytes}
          soulByteRatio={soulByteRatio}
          action={action}
          onBack={() => {
            if (!popScreen()) nav.resetTo({ screen: 'hub' });
          }}
          onSave={() => void handleSaveSoul()}
          onReload={bot => void loadBotSoul(bot)}
        />
      )}

      {/* ==================== SCREEN 7B: BOT SCHEDULED TASKS ==================== */}
      {screen === 'bot-schedules' && activeBot && (
        <BotSchedulesScreen
          activeBot={activeBot}
          botDisplayName={botMetaMap[activeBot.key]?.customName || activeBot.role}
          botScheduleState={botScheduleState}
          scheduleTasks={scheduleTasks}
          scheduleError={scheduleError}
          scheduleOffline={scheduleOffline}
          scheduleFilter={scheduleFilter}
          onChangeScheduleFilter={setScheduleFilter}
          scheduleEditing={scheduleEditing}
          onCancelEditing={() => setScheduleEditing(null)}
          scheduleDraft={scheduleDraft}
          setScheduleDraft={setScheduleDraft}
          scheduleCustomWeekdays={scheduleCustomWeekdays}
          setScheduleCustomWeekdays={setScheduleCustomWeekdays}
          scheduleDeleteTarget={scheduleDeleteTarget}
          setScheduleDeleteTarget={setScheduleDeleteTarget}
          action={action}
          onBack={() => {
            if (!popScreen()) nav.resetTo({ screen: 'hub' });
          }}
          onOpenCreate={openScheduleCreate}
          onOpenEdit={openScheduleEdit}
          onSaveSchedule={() => void handleSaveSchedule()}
          onToggleSchedule={(task, next) => void handleToggleSchedule(task, next)}
          onDeleteSchedule={task => void handleDeleteSchedule(task)}
          onRequestExactAlarm={() => void handleRequestExactAlarm()}
        />
      )}

      {(screen === 'conversation' || screen === 'dm' || screen === 'pending') && (
        <ScopesSubpageScreen
          mode={screen}
          active={active}
          scopeConversationTarget={scopeConversationTarget}
          scopeConversationSources={scopeConversationSources}
          localScopeApi={localScopeApi}
          resolveRoomApi={resolveRoomApi}
          roomMemberCandidates={roomMemberCandidates}
          knownBots={knownBots}
          onMarkRoomHistoryViewed={markRoomHistoryViewed}
          roomSettingsOpen={roomSettingsOpen}
          onRoomSettingsOpenChange={setRoomSettingsOpen}
          onRoomDeleted={deletedScopeId => {
            unconfirmedRoomDeletesRef.current.delete(deletedScopeId);
            chatPins.removePin(roomPinKey(deletedScopeId));
            markRoomConversationDeletedRef.current(deletedScopeId);
            setRoomSettingsOpen(false);
            setScopeConversationTarget(null);
            if (!popScreen()) nav.resetTo({ screen: 'hub' });
            refreshRoomConversationsRef.current();
          }}
          onOpenScopeLink={openScopeLink}
          onBackFromConversation={() => {
            setRoomSettingsOpen(false);
            if (!popScreen()) nav.resetTo({ screen: 'hub' });
          }}
          onOpenBot={handleOpenBot}
          dmTarget={dmTarget}
          dmSelectedScopeId={dmSelectedScopeId}
          onSelectDmScope={setDmSelectedScopeId}
          onBackFromDm={() => {
            if (!popScreen()) nav.resetTo({ screen: 'hub' });
          }}
          onBackFromPending={() => {
            if (!popScreen()) nav.resetTo({ screen: 'settings', settingsPage: 'overview' });
          }}
          remoteApi={remoteClientRef.current?.api ?? null}
          remoteIdentity={remoteIdentity}
          remoteConnected={remoteConnected}
          remoteDevices={remoteDevices}
          allBotItems={allBotItems}
          roomConversations={roomConversations}
          onOpenCenterSettings={openCenterSettings}
        />
      )}

      {/* ==================== SCREEN 8: SETTINGS VIEW ==================== */}
      {screen === 'settings' && (
        <HubSettingsView
          page={settingsPage}
          onOpenPage={nextPage => {
            if (nextPage === 'overview') nav.resetTo({ screen: 'settings', settingsPage: 'overview' });
            else nav.push({ screen: 'settings', settingsPage: nextPage });
          }}
          onBack={backFromSettings}
          onOpenDrawer={() => setLeftDrawerOpen(true)}
          drawerOpen={leftDrawerOpen}
          ensureRemoteApi={ensureRemoteApi}
          remoteProfiles={remoteProfiles}
          remoteIdentity={remoteIdentity}
          remoteConnected={remoteConnected}
          remoteDevices={remoteDevices}
          directoryReadFailed={directoryReadFailed}
          directoryCurrent={!directoryReadFailed && remoteConnected && remoteIdentity !== null &&
            remoteDirectory.identity?.generation === remoteIdentity.generation &&
            remoteDirectory.identity.profileId === remoteIdentity.profileId}
          localDeviceId={localHost?.deviceId}
          onRemoteDevices={(devices, identity) => setRemoteDirectory({ devices, identity, failedGeneration: null })}
          onRemoteUpdated={syncRemoteBots}
          archivedCount={archivedBots.length}
          onOpenArchivedBots={() => nav.push({ screen: 'archived-bots' })}
          onOpenPending={() => nav.push({ screen: 'pending' })}
          onOpenCenterAdmin={tab => openInAppCenterAdmin(tab ?? 'providers')}
          onOpenSystemSettings={onOpenSystemSettings}
        />
      )}

      {/* ==================== SCREEN 8A: IN-APP CENTER ADMIN VIEW ==================== */}
      {screen === 'settings-center-admin' && (
        <SettingsCenterAdminScreen
          transport={mobileCenterTransport}
          initialTab={centerAdminTab}
          onBack={closeInAppCenterAdmin}
          onOpenCenterSettings={openCenterSettings}
          onConfigureBot={(deviceId, botId) => {
            const target = allBotItems.find(item =>
              item.botId === botId &&
              (item.hostKind === 'local'
                ? (localHost?.deviceId === deviceId || item.deviceId === deviceId)
                : item.hostId === deviceId),
            );
            if (target) openBotProfile(target);
          }}
          onStartGoogleSetupWizard={(deviceId, botId) => {
            const target = allBotItems.find(item => item.deviceId === deviceId && item.botId === botId);
            if (!target) return;
            setActiveBotKey(target.key);
            nav.push({ screen: 'bot-google-setup', botKey: target.key });
          }}
        />
      )}

      {/* ==================== SCREEN 8C: BOT SKILLS FULL-SCREEN VIEW ==================== */}
      {screen === 'bot-skills' && activeBot && (
        <BotSkillsScreen
          activeBot={activeBot}
          activeCenter={activeCenter}
          localDeviceId={localHost?.deviceId}
          remoteConnected={remoteConnected}
          remoteIdentity={remoteIdentity}
          remoteApi={remoteClientRef.current?.api ?? null}
          botPanelIdentityKey={botPanelIdentityKey}
          botPanelConnected={botPanelConnected}
          callSkillReview={callSkillReview}
          onBack={() => {
            if (!popScreen()) {
              nav.resetTo({ screen: 'hub' });
              refreshDirectoryAfterConfig();
            }
          }}
          onOpenCenterSettings={openCenterSettings}
        />
      )}

      {/* ==================== SCREEN 8B: ARCHIVED BOTS LIST VIEW ==================== */}
      {screen === 'archived-bots' && (
        <ArchivedBotsScreen
          archivedBots={archivedBots}
          hasRemoteConfigured={hasRemoteConfigured}
          action={action}
          onBack={() => {
            if (!popScreen()) nav.resetTo({ screen: 'settings', settingsPage: 'overview' });
          }}
          onOpenBotChat={item => openBotChat(item, 'archived-bots')}
          onOpenContextMenu={setHubContextMenu}
          onUnarchive={item => void handleUnarchiveBot(item)}
          onRequestDelete={requestDeleteBot}
        />
      )}

      {modelTarget && activeBot?.key === modelTarget.botKey && activeBot.botId === modelTarget.botId &&
        activeCenter === modelTarget.center && remoteConnected && remoteIdentity?.generation === modelTarget.identity.generation &&
        (activeBot.hostKind === 'local' ? localHost?.deviceId : activeBot.hostId) === modelTarget.identity.targetDeviceId &&
        (screen === 'bot-profile' || screen === 'bot-profile-manage' || (screen === 'bot-edit' && editMode === 'edit')) &&
        (modelTarget.tab === 'capabilities' ? (
          <CapabilitiesPage
            key={`${modelTarget.center}|${modelTarget.botKey}|${modelTarget.identity.generation}|capabilities`}
            api={modelTarget.api}
            identity={modelTarget.identity}
            deviceId={modelTarget.identity.targetDeviceId}
            botId={modelTarget.botId}
            botName={activeBot.role}
            mode="tools"
            hostPlatform={activeBot.platform}
            isLocalAndroid={activeBot.hostKind === 'local' && !inTauriUi}
            callGoogleSetup={callGoogleSetup}
            onOpenBrowser={() => {
              setModelTarget(null);
              openBotBrowser();
            }}
            onOpenCenterAdmin={(tab = 'capabilities') => {
              setModelTarget(null);
              openInAppCenterAdmin(tab);
            }}
            onClose={closeModelTarget}
          />
        ) : (
          <MobileModelSettingsHost
            key={`${modelTarget.center}|${modelTarget.botKey}|${modelTarget.identity.generation}|model`}
            api={modelTarget.api}
            identity={modelTarget.identity}
            botId={modelTarget.botId}
            onOpenCenterAdmin={() => {
              setModelTarget(null);
              openInAppCenterAdmin('providers');
            }}
            onClose={closeModelTarget}
          />
        ))}

      {vaultTargetKey === botPanelIdentityKey && activeBot && screen === 'bot-profile' ? (
        <SettingsSheet title={t('密码凭据', 'Password Vault')} onClose={() => setVaultTargetKey(null)}>
          <VaultPanel
            identityKey={botPanelIdentityKey}
            botId={activeBot.botId}
            deviceId={activeBot.deviceId}
            hostLabel={`${activeBot.hostLabel} (${activeBot.deviceId})`}
            connected={botPanelConnected}
            call={callVault}
            onOpenGlobalVault={() => {
              setVaultTargetKey(null);
              openInAppCenterAdmin('vault');
            }}
          />
        </SettingsSheet>
      ) : null}

      {/* Hub 群聊 / Bot 长按·右键·键盘上下文菜单 */}
      <ConversationContextMenu
        position={hubContextMenu ? { x: hubContextMenu.x, y: hubContextMenu.y } : null}
        onClose={() => setHubContextMenu(null)}
        items={
          hubContextMenu?.room
            ? (() => {
                const room = hubContextMenu.room;
                const pKey = roomPinKey(room.scope.scope.scopeId);
                const pinned = chatPins.isPinned(pKey);
                return [
                  {
                    key: 'room-details',
                    label: t('查看群详情', 'Group Details'),
                    icon: <Users size={16} />,
                    onSelect: () => openScopeConversation(room, true),
                  },
                  {
                    key: 'room-pin',
                    label: pinned ? t('取消置顶', 'Unpin') : t('置顶', 'Pin'),
                    icon: pinned ? <PinOff size={16} /> : <Pin size={16} />,
                    onSelect: () => chatPins.togglePin(pKey),
                  },
                  {
                    key: 'room-delete',
                    label: t('解散并删除群聊', 'Disband & Delete Group'),
                    icon: <Trash2 size={16} />,
                    danger: true,
                    onSelect: () => openRoomDeleteConfirm(room),
                  },
                ];
              })()
            : hubContextMenu?.bot
              ? (() => {
                  const bot = hubContextMenu.bot;
                  if (bot.archivedAt) {
                    return [
                      {
                        key: 'bot-history',
                        label: t('查看只读历史', 'Read-only History'),
                        icon: <Clock size={16} />,
                        onSelect: () => openBotChat(bot, 'archived-bots'),
                      },
                      {
                        key: 'bot-profile',
                        label: t('查看资料', 'View Profile'),
                        icon: <User size={16} />,
                        onSelect: () => openBotProfile(bot),
                      },
                      {
                        key: 'bot-dm',
                        label: t('查看 Bot 私聊', 'View Bot DMs'),
                        icon: <MessageSquare size={16} />,
                        onSelect: () => openBotDmList(bot),
                      },
                      {
                        key: 'bot-unarchive',
                        label: t('恢复 Bot', 'Restore Bot'),
                        icon: <RotateCcw size={16} />,
                        onSelect: () => void handleUnarchiveBot(bot),
                      },
                      ...(!bot.isPrimary
                        ? [
                            {
                              key: 'bot-delete',
                              label: t('永久删除 Bot', 'Permanently Delete Bot'),
                              icon: <Trash2 size={16} />,
                              danger: true,
                              onSelect: () => requestDeleteBot(bot),
                            },
                          ]
                        : []),
                    ];
                  }
                  const canPin = bot.key !== primaryBot?.key;
                  const canArchiveOrDelete = !bot.isPrimary;
                  const pKey = botPinKey(bot);
                  const pinned = chatPins.isPinned(pKey);
                  return [
                    {
                      key: 'bot-profile',
                      label: t('查看资料', 'View Profile'),
                      icon: <User size={16} />,
                      onSelect: () => openBotProfile(bot),
                    },
                    ...(canPin
                      ? [
                          {
                            key: 'bot-pin',
                            label: pinned ? t('取消置顶', 'Unpin') : t('置顶', 'Pin'),
                            icon: pinned ? <PinOff size={16} /> : <Pin size={16} />,
                            onSelect: () => chatPins.togglePin(pKey),
                          },
                        ]
                      : []),
                    {
                      key: 'bot-dm',
                      label: t('查看 Bot 私聊', 'View Bot DMs'),
                      icon: <MessageSquare size={16} />,
                      onSelect: () => openBotDmList(bot),
                    },
                    ...(canArchiveOrDelete
                      ? [
                          {
                            key: 'bot-archive',
                            label: t('归档 Bot', 'Archive Bot'),
                            icon: <Archive size={16} />,
                            onSelect: () => requestArchiveBot(bot),
                          },
                          {
                            key: 'bot-delete',
                            label: t('永久删除 Bot', 'Permanently Delete Bot'),
                            icon: <Trash2 size={16} />,
                            danger: true,
                            onSelect: () => requestDeleteBot(bot),
                          },
                        ]
                      : []),
                  ];
                })()
              : undefined
        }
        onViewPrivateChats={() => {
          const bot = hubContextMenu?.bot;
          if (bot) openBotDmList(bot);
          else setHubContextMenu(null);
        }}
      />

      {/* 聊天消息气泡长按底部操作表（移动端 coarse 指针） */}
      {(() => {
        const bubbleActionItems: ActionSheetItem[] = [];
        if (bubbleActionTurn && activeBot) {
          const { turn, editable, canRetry } = bubbleActionTurn;
          const textToUse = turn.text.trim();
          if (textToUse) {
            bubbleActionItems.push({
              key: 'copy',
              label: t('复制', 'Copy'),
              icon: <Copy size={18} />,
              onSelect: () => {
                if (navigator.clipboard?.writeText) {
                  void navigator.clipboard.writeText(turn.text).then(
                    () => {
                      const msg = t('已复制', 'Copied');
                      setClearNotice(msg);
                      window.setTimeout(() => setClearNotice(prev => (prev === msg ? '' : prev)), 1800);
                    },
                    () => {},
                  );
                }
              },
            });
            if (!activeBot.archivedAt && !activeEditing) {
              bubbleActionItems.push({
                key: 'quote',
                label: t('引用回复', 'Quote'),
                icon: <Quote size={18} />,
                onSelect: () => {
                  const quoted =
                    textToUse
                      .split('\n')
                      .slice(0, 6)
                      .map(line => `> ${line}`)
                      .join('\n') + '\n\n';
                  if (activeBot.hostKind === 'remote' && activeBot.remoteIdentity && remoteClientRef.current) {
                    setPendingRemoteQuote(prev => ({ seq: (prev?.seq ?? 0) + 1, text: textToUse }));
                  } else {
                    const next = chatDraft ? `${chatDraft.trimEnd()}\n${quoted}` : quoted;
                    setChatDraft(next);
                    if (currentChatScope.current) writeChatDraft(currentChatScope.current, next);
                    requestAnimationFrame(() => composerTextareaRef.current?.focus());
                  }
                },
              });
            }
          }
          if (editable) {
            bubbleActionItems.push({
              key: 'edit',
              label: t('编辑', 'Edit'),
              icon: <Pencil size={18} />,
              onSelect: () => {
                setComposerImageError('');
                setEditingTurn({
                  botKey: activeBot.key,
                  scopeKey: activeChatScope,
                  entryId: turn.entryId,
                  text: turn.text,
                  attachments: turn.attachments ? turn.attachments.map(a => ({ ...a })) : [],
                });
                requestAnimationFrame(() => composerTextareaRef.current?.focus());
              },
            });
          }
          if (canRetry) {
            bubbleActionItems.push({
              key: 'retry',
              label: t('重试发送', 'Retry sending'),
              icon: <RotateCcw size={18} />,
              onSelect: () => {
                if (activeBot.hostKind === 'local') void retryAdmission();
                else void retryRemoteAdmission();
              },
            });
          }
        }
        return (
          <ActionSheet
            open={bubbleActionItems.length > 0}
            onOpenChange={open => {
              if (!open) setBubbleActionTurn(null);
            }}
            title={t('消息操作', 'Message actions')}
            items={bubbleActionItems}
          />
        );
      })()}

      {/* 清空当前对话历史确认弹窗 */}
      <ConfirmDialog
        open={clearConfirmOpen}
        title={t('清空对话历史', 'Clear Conversation History')}
        description={t('确定要清空当前对话记录并重置上下文吗？此操作不可撤销。',
          'Clear the current conversation history and reset context? This cannot be undone.')}
        danger
        onCancel={() => setClearConfirmOpen(false)}
        onConfirm={() => {
          mobileHaptic('confirm');
          setClearConfirmOpen(false);
          const scope = activeChatScope;
          void runSlashCommand('/clear').catch(error => {
            if (currentChatScope.current === scope) setClearNotice(errorText(error));
          });
        }}
      />

      {/* Bot 归档 / 永久删除 二次确认弹窗 */}
      <ConfirmDialog
        open={botConfirmModal !== null}
        title={
          botConfirmModal?.kind === 'archive'
            ? t('归档 Bot', 'Archive Bot')
            : t('永久删除 Bot', 'Permanently Delete Bot')
        }
        description={
          botConfirmModal?.kind === 'archive'
            ? t(`确定要归档「${botConfirmModal.bot.role}」吗？归档后将移至「设置 · 已归档 Bot」并保留 14 天，期间可查看只读历史或随时恢复，14 天后自动清理。`,
                `Archive "${botConfirmModal.bot.role}"? It will move to Settings > Archived Bots for 14 days (read-only history, restorable) before auto-deletion.`)
            : botConfirmModal
              ? t(`确定要永久删除 Bot「${botConfirmModal.bot.role}」及其所有历史对话与人设文档吗？此操作不可恢复。`,
                  `Permanently delete "${botConfirmModal.bot.role}" and all its conversation history and persona? This cannot be undone.`)
              : ''
        }
        danger={botConfirmModal?.kind === 'delete'}
        onCancel={() => {
          if (!action.busy) setBotConfirmModal(null);
        }}
        onConfirm={() => {
          if (!botConfirmModal || action.busy) return;
          mobileHaptic('confirm');
          const target = botConfirmModal;
          setBotConfirmModal(null);
          if (target.kind === 'archive') {
            void handleArchiveBot(target.bot);
          } else {
            void handleDeleteBot(target.bot);
          }
        }}
      />

      {/* 群聊解散并删除二次确认弹窗（先读 authority 最新 scope 冻结 requestId / expectedRevision，未确认可按原 ID 确认） */}
      <Dialog
        open={roomDeleteModal !== null}
        onOpenChange={open => {
          if (!open && roomDeleteModal && !roomDeleteModal.submitting) {
            roomDeleteFetchSeqRef.current += 1;
            setRoomDeleteModal(null);
          }
        }}
        title={t('解散并删除群聊', 'Disband & Delete Group')}
      >
        {roomDeleteModal && (
          <>
            <p className="secondary">
              {roomDeleteModal.loadingLatest
                ? t('正在从权威节点读取最新群聊信息…', 'Reading latest group state from authority node…')
                : t(`确定要解散并删除群聊「${roomDeleteModal.attempt?.title || roomDeleteModal.room.title}」吗？所有设备上的该群聊及全部群历史消息都将被删除，此操作不可恢复。`,
                    `Disband and delete group "${roomDeleteModal.attempt?.title || roomDeleteModal.room.title}"? The group and all its message history across all devices will be deleted. This cannot be undone.`)}
            </p>
            {roomDeleteModal.error && (
              <ErrorNotice compact error={roomDeleteModal.error} />
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary-button"
                disabled={roomDeleteModal.submitting}
                onClick={() => {
                  roomDeleteFetchSeqRef.current += 1;
                  setRoomDeleteModal(null);
                }}
              >
                {t('取消', 'Cancel')}
              </button>
              {roomDeleteModal.conflictNeedReload && !roomDeleteModal.attempt?.unconfirmed && (
                <button
                  type="button"
                  className="button secondary-button"
                  disabled={roomDeleteModal.loadingLatest || roomDeleteModal.submitting}
                  onClick={() => void loadLatestRoomForDelete(roomDeleteModal.room)}
                >
                  {t('重新读取', 'Reload')}
                </button>
              )}
              {roomDeleteModal.attempt && (
                <button
                  type="button"
                  className="button danger-button"
                  disabled={roomDeleteModal.loadingLatest || roomDeleteModal.submitting}
                  onClick={() => {
                    mobileHaptic('confirm');
                    void executeRoomDelete();
                  }}
                >
                  {roomDeleteModal.submitting
                    ? t('正在处理…', 'Processing…')
                    : roomDeleteModal.attempt.unconfirmed
                      ? t('按原 ID 确认', 'Confirm Original ID')
                      : t('解散并删除群聊', 'Disband & Delete Group')}
                </button>
              )}
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
