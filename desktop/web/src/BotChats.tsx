// Bot 私聊 lane（desktop/web）：Hub 列表栏 + 主对话舞台 + 右侧工作台抽屉。
// 设计依据 desktop-gui-fresh-argon-design §5.2/§5.3/§5.4；
// 全部请求仍走既有 useDrafts / pending_enqueue / pending_send / observe 路径，
// 保留 CAS、显式发送、结果未确认锁与离线只读语义。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode, RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  Clock,
  Cpu,
  FileText,
  Globe,
  History,
  Image as ImageIcon,
  LockKeyhole,
  MessageSquare,
  MessagesSquare,
  Monitor,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Square,
  Star,
  Trash2,
  User,
  Users,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  IMAGE_MAX_COUNT,
  IMAGE_MAX_TOTAL_BYTES,
  ImageAttachmentThumb,
  attachmentFileName,
  attachmentIdOf,
  normalizeImageFile,
  pickImagesFromInput,
  type AttachmentFetcher,
  type ImageAttachmentData,
  type PickedImageSource,
} from '../../../web/src/imageAttachments';
import type { ImageAttachment } from '../../../host-core/index.js';
import type { DesktopIdentity, DesktopImagePickSource, DesktopPanelApi } from './types';
import {
  decideImagePasteAction,
  isDesktopLinuxPlatform,
  pickedImagesToFiles,
} from './imagePaste';
import type { DesktopObservationEvent } from './types';
import { ErrorNotice, useText } from '../../../web/src/ui';
import {
  ActionBar,
  ConditionDock,
  ConfirmDialog,
  InlineBanner,
  PopoverMenu,
  Select,
  type ConditionDockItem,
  type PopoverMenuItem,
} from '../../../web/src/components/ui';
import { hasOpenFloatingPopover, isEventInsideFloatingUi } from '../../../web/src/components/ui/Overlay';
import { BotReadScope } from '../../../web/src/botReadScope';
import { deleteBotAndVerify, hasAntigravityHistory } from '../../../web/src/botOperations';
import { SendButtonIcon } from '../../../web/src/SendButtonIcon';
import { useReceiptRecovery } from '../../../web/src/useReceiptRecovery';
import type {
  AbortBotResult,
  BotLiveState,
  BotDirectoryEntry,
  BotRecord,
  ClearHistoryResult,
  MessageMember,
  CompactResult,
  DevicesDirectoryItem,
  PendingCursor,
  PendingEnqueueInput,
  PendingListPage,
  PendingRecord,
  PrimarySubmission,
  ScopeInfo,
  TurnDeliveryMode,
  WithdrawQueuedResult,
  WithdrawnTurnItem,
} from '../../../host-core/index.js';
import { isTargetOfflineError, toError } from './api';
import { useDrafts } from './drafts';
import type { DraftSnapshot } from './drafts';
import {
  readToolPresentation,
  type GoogleChatCardContext,
  type QuestionnaireSubmitPayload,
  type VaultUnlockSubmitPayload,
} from '../../../web/src/ToolPresentation';
import BotBrowserPanel from '../../../web/src/bot-browser/BotBrowserPanel';
import type { BrowserDestination } from '../../../web/src/bot-browser/protocol';
import { desktopNativeBrowser, type DesktopNativeBrowser } from './nativeBrowser';
import { createBrowserFrameSubscriber } from '../../../web/src/bot-browser/relayStream';
import { GoogleSetupWizard } from '../../../web/src/google/GoogleSetupWizard';
import { continueGoogleSetupAfterSignInRejection } from '../../../web/src/google/currentGoogleSetup';
import { openExternalUrl } from '../../../web/src/center-admin/openExternalUrl';
import {
  createBrowserControlRequest,
  createGoogleSetupControlRequest,
} from '../../../web/src/google/googleClient';
import { GrokBotAvatar } from '../../../web/src/GrokBotAvatar';
import { BotBoard } from '../../../web/src/BotBoard';
import { botBoardKey, useBotBoard, useMarkViewedBoardResult, type BotBoardTarget } from '../../../web/src/useBotBoard';
import {
  botActivityText,
  canSteerBotActivity,
  canStopBotActivity,
  isBotActivityBusy,
  isBotLlmRunningPhase,
  isBotPreLlmPhase,
  resolveBotActivity,
  resolveComposerActionKind,
  shouldShowComposerStop,
  type BotActivity,
} from '../../../web/src/botActivity';
import { botAvatarKey, syncBotAvatarConfigs } from '../../../web/src/botAvatarSync';
import { formatBotModelSummary } from '../../../web/src/bot-settings/modelDisplay';
import { BotSettings, type BotSettingsTab } from './BotSettings';
import type { CenterModelPicker } from '../../../host-core/desktop-client.js';
import type { CenterAdminTab } from './SettingsPanel';
import type { DesktopBotDirectoryEntry } from './types';
import { ShowerPreview } from './ShowerPreview';
import { ChatTranscript } from './ChatTranscript';
import type { ChatTurn, KnownBotSummary } from '../../../web/src/chatTurnModel';
import {
  mergeQueuedStripItems,
  resolveAttachmentMetasByIds,
  stripTrailingHostAttachmentLines,
  type UnifiedQueuedStripItem,
} from '../../../web/src/composerFlowControl';
import { ComposerEditBanner, PendingQueueStrip } from '../../../web/src/ComposerFlowStrips';
import { BotAvatarStudio } from './BotAvatarStudio';
import { targetApi } from './targetApi';
import { HistoryEpochChangedError, readHistoryPage } from './history';
import { Scopes } from './Scopes';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { MemberApiResolver, RoomApiResolver, ScopeReadApi } from './scope-api';
import {
  ConversationContextMenu,
  ConversationGroupAvatar,
  ConversationRow,
  useConversationRowInteractions,
  useScopeConversations,
} from '../../../web/src/gbot-ui/index';
import type { ConversationMenuItem } from '../../../web/src/gbot-ui/ConversationContextMenu';
import { useChatPins } from '../../../web/src/gbot-ui/chatPins';
import { SortablePinnedChat } from '../../../web/src/gbot-ui/SortablePinnedChat';
import { useConversationUnread } from '../../../web/src/gbot-ui/useConversationUnread';
import {
  useGlobalTasks,
  TaskBoardView,
  TaskChatPromptBanner,
  isTaskWaitingForBot,
  resolveBotChatTaskContext,
  type GlobalTask,
  type TaskBotOption,
  type TaskTransportFn,
} from '../../../web/src/tasks';
import './BotChats.css';

type PendingTaskChatAction =
  | {
      kind: 'answer_prompt';
      scopeKey: string;
      botKey: string;
      taskId: string;
      taskTitle: string;
      answer: string;
      expectedRevision?: number;
      error: string;
    }
  | {
      kind: 'confirm_plan';
      scopeKey: string;
      botKey: string;
      taskId: string;
      taskTitle: string;
      expectedRevision?: number;
      error: string;
    }
  | {
      kind: 'update_task';
      scopeKey: string;
      botKey: string;
      taskId: string;
      taskTitle: string;
      payload: Record<string, unknown> & { taskId: string };
      error: string;
    };

type PendingTaskChatActionInput =
  | Omit<Extract<PendingTaskChatAction, { kind: 'answer_prompt' }>, 'error'>
  | Omit<Extract<PendingTaskChatAction, { kind: 'confirm_plan' }>, 'error'>
  | Omit<Extract<PendingTaskChatAction, { kind: 'update_task' }>, 'error'>;

const IS_MAC_PLATFORM =
  typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
const SHORTCUT_MOD_LABEL = IS_MAC_PLATFORM ? '⌘' : 'Ctrl+';
const SHORTCUT_K_KBD = IS_MAC_PLATFORM ? '⌘K' : 'Ctrl K';

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"], [contenteditable=""]'));
}

function hasBlockingWorkbenchOverlay(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(
    document.querySelector(
      '[role="dialog"][aria-modal="true"], [data-browser-overlay="true"], [data-shower-overlay], .image-attachment-viewer, .image-attachment-viewer-content',
    ),
  );
}

const FLOATING_OUTSIDE_GUARD_PROPS = {
  onPointerDownOutside: (event: { target: EventTarget | null; preventDefault(): void }) => {
    if (isEventInsideFloatingUi(event)) event.preventDefault();
  },
  onFocusOutside: (event: { target: EventTarget | null; preventDefault(): void }) => {
    if (isEventInsideFloatingUi(event)) event.preventDefault();
  },
  onInteractOutside: (event: { target: EventTarget | null; preventDefault(): void }) => {
    if (isEventInsideFloatingUi(event)) event.preventDefault();
  },
};

type AnyRawEntry = { id: unknown; kind: string; model?: unknown; data?: unknown };

function readClearedThroughEntryId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function numericRawEntryId(item: unknown): number {
  const id = Number((item as { id?: unknown } | null)?.id);
  return Number.isFinite(id) ? id : 0;
}

function latestResetEntryIdFromItems(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  let max = 0;
  for (const item of items) {
    if (item && typeof item === 'object' && (item as { kind?: unknown }).kind === 'pi.reset') {
      const id = Number((item as { id?: unknown }).id);
      if (Number.isSafeInteger(id) && id > max) max = id;
    }
  }
  return max;
}

function isStaleLiveState(state: BotLiveState | null, cutoff: number): boolean {
  if (!state || cutoff <= 0) return false;
  const history = Array.isArray(state.history) ? state.history : [];
  if (history.some((item) => item?.kind === 'pi.reset' && numericRawEntryId(item) >= cutoff)) return false;
  const lastId = typeof state.lastEntryId === 'number' && Number.isFinite(state.lastEntryId) ? state.lastEntryId : null;
  if (lastId !== null && lastId > cutoff) return false;
  return !history.some((item) => numericRawEntryId(item) > cutoff);
}

function describeClearError(
  action: '清空对话' | '/clear',
  e: unknown,
  connected: boolean,
  formatErr: (err: unknown) => string,
): { message: string; isUnknown: boolean } {
  const err = toError(e);
  if (err.outcome === 'unconfirmed') {
    return {
      isUnknown: true,
      message: `${action} 结果未确认（${formatErr(e)}）：${connected ? '已刷新历史核实状态' : '恢复连接后请刷新历史核实'}，草稿与历史保留，不会自动重发。`,
    };
  }
  if (err.outcome === 'responded' && err.code === 'RUNTIME_BUSY') {
    return {
      isUnknown: false,
      message: `${action} 未执行：Bot 当前忙碌（${formatErr(e)}），草稿保留，请等待任务完成后重试。`,
    };
  }
  return {
    isUnknown: false,
    message: `${action} 失败：${formatErr(e)}；草稿与历史保留，不会自动重发。`,
  };
}

const ARCHIVE_RETENTION_DAYS = 14;
/** 与 BotChats.css 并排断点一致：≥1200px 抽屉并排非模态，<1200px 浮层模态。 */
const INSPECTOR_COMPACT_QUERY = '(max-width: 1199px)';

/** 与 BotChats.css 断点同一媒体查询；判定紧凑浮层态以决定是否启用模态焦点约束。 */
function useInspectorCompact(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(INSPECTOR_COMPACT_QUERY).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(INSPECTOR_COMPACT_QUERY);
    const onChange = () => setCompact(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return compact;
}
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DIRECTORY_POLL_INTERVAL_MS = 2000;

interface CachedBotDirectory {
  bots: BotDirectoryEntry[];
  devices: DevicesDirectoryItem[];
  updatedAt: string;
}

function directoryCacheKey(profileKey: string): string {
  return `desktop-bot-dir-v5:${profileKey}`;
}

function readDirectoryCache(profileKey: string): CachedBotDirectory | null {
  if (!profileKey || typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(directoryCacheKey(profileKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedBotDirectory>;
    if (!Array.isArray(parsed.bots) || !Array.isArray(parsed.devices)) return null;
    // 缓存仅恢复列表内容，不冒充实时在线：online 一律置 false，等下一次成功刷新恢复。
    return {
      bots: parsed.bots.map((b) => ({ ...b, online: false })),
      devices: parsed.devices.map((d) => ({ ...d, online: false })),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

function writeDirectoryCache(
  profileKey: string,
  bots: BotDirectoryEntry[],
  devices: DevicesDirectoryItem[],
): void {
  if (!profileKey || typeof window === 'undefined' || !window.localStorage) return;
  try {
    const payload: CachedBotDirectory = {
      bots,
      devices,
      updatedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(directoryCacheKey(profileKey), JSON.stringify(payload));
  } catch {
    // 忽略 localStorage 配额或权限限制
  }
}

type LastChat = { kind: 'bot' | 'scope'; deviceId: string; id: string };

function readLastChat(profileKey: string): LastChat | null {
  if (!profileKey) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(`desktop-last-chat:v1:${profileKey}`) ?? 'null') as Partial<LastChat> | null;
    if ((saved?.kind === 'bot' || saved?.kind === 'scope') && typeof saved.deviceId === 'string' &&
        typeof saved.id === 'string' && saved.id && saved.deviceId) {
      return { kind: saved.kind, deviceId: saved.deviceId, id: saved.id };
    }
  } catch {
    // 无法读取时仍可打开默认会话。
  }
  return null;
}

export function archiveExpiryAt(archivedAt?: string | null): number | null {
  const archivedMs = archivedAt ? Date.parse(archivedAt) : NaN;
  return Number.isFinite(archivedMs) ? archivedMs + ARCHIVE_RETENTION_DAYS * MS_PER_DAY : null;
}

export function remainingArchiveDays(archivedAt: string | null | undefined): number {
  const expiresAt = archiveExpiryAt(archivedAt);
  return expiresAt === null ? ARCHIVE_RETENTION_DAYS : Math.max(0, Math.ceil((expiresAt - Date.now()) / MS_PER_DAY));
}

function botPinKey(deviceId: string, botId: string): string {
  return `bot:${deviceId}:${botId}`;
}

function roomPinKey(scopeId: string): string {
  return `room:${scopeId}`;
}

export interface BotChatsArchiveBridge {
  archivedBots: BotDirectoryEntry[];
  devices: DevicesDirectoryItem[];
  online: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  openBotHistory: (bot: BotDirectoryEntry) => void;
  unarchiveBot: (bot: BotDirectoryEntry) => Promise<void>;
  deleteBot: (bot: BotDirectoryEntry) => Promise<void>;
  conversationName: (target: SendRecordsTarget) => string | undefined;
  openConversation: (target: SendRecordsTarget, panel?: 'profile' | 'google-setup') => void;
}

export interface SendRecordsTarget {
  deviceId: string;
  recordId?: string;
  botId?: string;
  scopeId?: string;
}

function botSortTimestamp(b: Pick<BotRecord, 'lastActivityAt' | 'createdAt'>): number {
  return Date.parse(b.lastActivityAt || b.createdAt || '') || 0;
}

function sessionKey(id: DesktopIdentity | null): string {
  return id ? `${id.profileId}|${id.generation}|${id.targetDeviceId}` : '';
}



function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const r = e as Record<string, unknown>;
    const code = typeof r.code === 'string' ? r.code.trim() : '';
    let message = typeof r.message === 'string' ? r.message.trim() : '';
    if (code && message.startsWith(`${code}:`)) {
      message = message.slice(code.length + 1).trim();
    }
    if (
      message === code ||
      /^(unconfirmed|not-sent|responded)$/i.test(message) ||
      /^(unconfirmed|not-sent|responded):\s*[A-Z0-9_]+$/i.test(message)
    ) {
      message = '';
    }
    if (code) return message ? `${code}: ${message}` : code;
    if (message) return message;
  }
  return String(e);
}

/** 判断是否为对端节点离线/连接断开错误。 */
function isPeerDisconnectError(e: unknown): boolean {
  if (isTargetOfflineError(e)) return true;
  const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
  return code === 'DISCONNECTED' || code === 'NOT_CONNECTED' || code === 'EVENT_STREAM_CLOSED';
}

/** 目标 Host 不可达或连接断开只展示在对应聊天上下文，不上顶栏全局横幅；
 * 其余错误照旧 reportError。 */
function reportUnlessTargetOffline(api: { reportError(e: unknown): void }, e: unknown): void {
  if (!isPeerDisconnectError(e)) api.reportError(e);
}

/** 只有 error.outcome 明确 not-sent（未派发）才可判定未入队；其余一律视为结果未知。 */
function isNotSent(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { outcome?: unknown }).outcome === 'not-sent';
}

/**
 * 按 contract §7 的 TurnAdmissionStatus 本地形状读取：字段缺失即视为无该信息。
 * protocol lane 尚未在共享 d.ts 声明；这里读的是 PendingRecord.receipt（已入库的 Record）。
 */
interface TurnAdmissionView {
  requestId: string;
  phase: 'queued' | 'checking' | 'synchronizing' | 'failed';
  source?: 'primary' | 'background';
  error: { code: string; message: string } | null;
}

const TURN_ADMISSION_PHASES = new Set(['queued', 'checking', 'synchronizing', 'failed']);

/** Host-queued 回执：status queued 且 submissionId null，本地持久化后等待准入与原生提交。 */
interface HostQueuedReceipt {
  status: 'queued';
  submissionId: null;
  admission: TurnAdmissionView | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 宽容读取 admission：形状非法/字段缺失返回 null（状态不渲染），不读取文本/凭据。 */
function readTurnAdmission(value: unknown): TurnAdmissionView | null {
  if (!isRecord(value)) return null;
  if (typeof value.requestId !== 'string') return null;
  if (typeof value.phase !== 'string' || !TURN_ADMISSION_PHASES.has(value.phase)) return null;
  let error: TurnAdmissionView['error'] = null;
  if (isRecord(value.error)) {
    error = {
      code: typeof value.error.code === 'string' ? value.error.code : 'UNKNOWN',
      message: typeof value.error.message === 'string' ? value.error.message : '',
    };
  }
  return {
    requestId: value.requestId,
    phase: value.phase as TurnAdmissionView['phase'],
    ...(value.source === 'primary' || value.source === 'background' ? { source: value.source } : {}),
    error,
  };
}

/** 从 PendingRecord.receipt 读取 queued/null-submission 与可选 admission；二者皆缺返回 null。 */
function readHostQueuedReceipt(record: PendingRecord | null): HostQueuedReceipt | null {
  if (!record || !isRecord(record.receipt)) return null;
  const r = record.receipt;
  const admission = readTurnAdmission(r.admission);
  if (r.status === 'queued' && r.submissionId === null) return { status: 'queued', submissionId: null, admission };
  return admission ? { status: 'queued', submissionId: null, admission } : null;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 按 pi-ai Message（pi-durable EntryRecord.model）真实结构提取安全文本行。 */
function entryTextLines(entry: AnyRawEntry): string[] {
  const lines: string[] = [];
  if (!Array.isArray(entry.model)) return lines;
  for (const raw of entry.model) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as Record<string, unknown>;
    const role = typeof msg.role === 'string' ? msg.role : '';
    const content = msg.content;
    if (typeof content === 'string') {
      lines.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const partRaw of content) {
        if (!partRaw || typeof partRaw !== 'object') continue;
        const part = partRaw as Record<string, unknown>;
        if (part.type === 'text' && typeof part.text === 'string') lines.push(part.text);
        else if (part.type === 'thinking' && typeof part.thinking === 'string') lines.push('[思考] ' + part.thinking);
        else if (part.type === 'image') lines.push('[图片内容]');
        else if (part.type === 'toolCall' && typeof part.name === 'string') {
          lines.push(`调用 ${part.name}`);
        }
      }
      continue;
    }
    if (role === 'toolResult' && typeof msg.toolName === 'string') {
      lines.push(`[工具结果] ${msg.toolName}${msg.isError === true ? '（错误）' : ''}`);
    }
  }
  return lines.filter(Boolean);
}

function RawEntryRow({ entry }: { entry: AnyRawEntry }) {
  const label = ({
    'pi.user': '用户消息',
    'pi.assistant': 'Bot 回复',
    'pi.tool-result': '工具结果',
    'pi.reset': '对话已清空',
  } as Record<string, string>)[entry.kind] ?? '会话事件';
  const summary = truncate(entryTextLines(entry).join('\n'), 320);
  return (
    <div className="raw-entry">
      <strong>{label}</strong>
      {summary ? <p className="raw-entry-text">{summary}</p> : null}
      <details className="raw-entry-json">
        <summary>事件 ID 与原始 JSON</summary>
        <p className="metadata">{String(entry.id)} · {entry.kind}</p>
        <pre>{JSON.stringify(entry, null, 2)}</pre>
      </details>
    </div>
  );
}

/** 原始历史工作台页签内容（非折叠容器，外层是 inspector 页签）。 */
function RawHistoryPane({ items, loading, error, onLoadMore, hasMore, onRetry, offline }: {
  items: AnyRawEntry[];
  loading: boolean;
  error: string | null;
  onLoadMore: () => void;
  hasMore: boolean;
  onRetry: () => void;
  offline: boolean;
}) {
  return (
    <div className="inspector-raw-history">
      {offline ? <div className="status">离线：显示最后读取的原始历史，不自动请求。</div> : null}
      {error ? (
        <div className="error-banner" role="alert">
          {error}
          <button type="button" onClick={onRetry} disabled={offline}>重试</button>
        </div>
      ) : null}
      {items.length === 0 && !loading && !error ? (
        <div className="empty-state">暂无历史条目。</div>
      ) : null}
      {items.map((it) => <RawEntryRow key={String(it.id)} entry={it} />)}
      {loading ? <div className="status">加载中…</div> : null}
      {hasMore && !loading ? (
        <button type="button" className="secondary-button" onClick={onLoadMore} disabled={offline}>
          加载更多消息
        </button>
      ) : null}
    </div>
  );
}

function CreateBotForm({
  api,
  devices,
  bots,
  initialDeviceId = '',
  onCreated,
  onCancel,
}: {
  api: DesktopPanelApi;
  devices: DevicesDirectoryItem[];
  bots: BotDirectoryEntry[];
  initialDeviceId?: string;
  onCreated: (deviceId: string, bot: BotRecord) => void;
  onCancel?: () => void;
}) {
  const t = useText();
  const [deviceId, setDeviceId] = useState(initialDeviceId);
  const [role, setRole] = useState('');
  const [description, setDescription] = useState('');
  const [cwd, setCwd] = useState('');
  const [selectedModelRef, setSelectedModelRef] = useState('');
  const [modelCatalog, setModelCatalog] = useState<CenterModelPicker | null>(null);
  const [makePrimary, setMakePrimary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const sendingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const id = api.identity;
    if (!id || !api.transportConnected) return;
    let active = true;
    void api.broker(id, 'center_model_picker_get', {}).then(
      (picker) => {
        if (active && mountedRef.current) setModelCatalog(picker);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [api, api.identity, api.transportConnected]);

  const defaultModelRef = modelCatalog?.defaultModel ?? null;
  const defaultModelEntry = defaultModelRef
    ? modelCatalog?.models.find((m) => m.modelRef === defaultModelRef)
    : undefined;
  const defaultModelLabel = defaultModelEntry
    ? `跟随全局默认（${defaultModelEntry.name}）`
    : defaultModelRef
      ? `跟随全局默认（${defaultModelRef}）`
      : '跟随全局默认';

  const targetHasPrimary = useMemo(
    () =>
      Boolean(
        deviceId &&
          bots.some((b) => b.deviceId === deviceId && b.isPrimary && !b.archivedAt),
      ),
    [deviceId, bots],
  );
  const forcePrimary = Boolean(deviceId && !targetHasPrimary);
  const effectiveMakePrimary = forcePrimary ? true : makePrimary;

  function handleSelectDevice(nextDeviceId: string) {
    setDeviceId(nextDeviceId);
    setMakePrimary(false);
  }

  async function submit() {
    if (sendingRef.current || busy || locked) return;
    if (!deviceId || !devices.some((d) => d.deviceId === deviceId && d.online)) {
      setError('请选择在线目标设备；目标失效时不会改用本机。');
      return;
    }
    if (!role.trim()) {
      setError('请输入 Bot 名称。');
      return;
    }
    sendingRef.current = true;
    setBusy(true);
    setError(null);
    const requestId = crypto.randomUUID();
    try {
      const identity = api.identityForTarget(deviceId);
      const bot = await api.mutateIntent(identity, 'createBot', {
        requestId,
        role: role.trim(),
        description: description.trim(),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        modelRef: null,
        ...(effectiveMakePrimary ? { makePrimary: true } : {}),
      });
      if (!mountedRef.current) return;
      let createdBot: BotRecord = effectiveMakePrimary ? { ...bot, isPrimary: true } : bot;
      if (selectedModelRef && api.identity && api.transportConnected) {
        try {
          const cfg = await api.broker(api.identity, 'center_bot_model_get', { deviceId, botId: bot.botId });
          await api.broker(api.identity, 'center_bot_model_set', {
            deviceId,
            botId: bot.botId,
            expectedRevision: cfg.revision,
            value: { modelRef: selectedModelRef },
          });
          createdBot = { ...createdBot, modelRef: selectedModelRef };
        } catch {
          // Bot 本体已创建成功；专属模型写入失败时仍进入对话，后续可在配置中调整。
        }
      }
      if (!mountedRef.current) return;
      setRole('');
      setDescription('');
      setCwd('');
      setSelectedModelRef('');
      onCreated(deviceId, createdBot);
    } catch (e) {
      if (!mountedRef.current) return;
      if (
        !isNotSent(e) &&
        !(e && typeof e === 'object' && (e as { outcome?: string }).outcome === 'responded')
      ) {
        setLocked(true);
      }
      setError(
        `${errText(e)}（结果尚未确认，可在发送记录里核对结果）`,
      );
      reportUnlessTargetOffline(api, e);
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <form
      className="form-grid"
      style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        {t('名称', 'Name')}
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={busy || locked}
          autoFocus
        />
      </label>
      <label className="field">
        {t('职责（可选）', 'Role description (optional)')}
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          disabled={busy || locked}
        />
      </label>
      <div className="field">
        <label htmlFor="create-bot-model">{t('模型（可选）', 'Model (optional)')}</label>
        <Select
          id="create-bot-model"
          value={selectedModelRef}
          onChange={setSelectedModelRef}
          options={[
            { value: '', label: defaultModelLabel },
            ...(modelCatalog?.models ?? []).map((model) => ({
              value: model.modelRef,
              label: model.name,
              description: model.modelRef,
            })),
          ]}
          ariaLabel={t('选择模型', 'Select model')}
          disabled={busy || locked}
        />
      </div>
      <p className="hint">
        {deviceId
          ? t(`创建于 ${devices.find(device => device.deviceId === deviceId)?.displayName || '所选设备'}`, `Creating on ${devices.find(device => device.deviceId === deviceId)?.displayName || 'selected device'}`)
          : t('请在高级设置中选择在线设备。', 'Select an online device in Advanced settings.')}
      </p>
      {forcePrimary ? (
        <p className="hint">{t('该设备当前没有主 Bot，创建后会自动设为主 Bot。', 'This device has no primary bot yet; the new bot will become primary.')}</p>
      ) : null}
      <details className="bot-form-advanced">
        <summary>{t('高级设置', 'Advanced settings')}</summary>
        <div className="form-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <div className="field">
            <label htmlFor="create-bot-device">{t('目标设备', 'Target device')}</label>
            <Select
              id="create-bot-device"
              value={deviceId}
              onChange={handleSelectDevice}
              options={[
                { value: '', label: t('请选择设备', 'Select a device') },
                ...devices.map(device => ({
                  value: device.deviceId,
                  label: `${device.displayName || t('未命名设备', 'Unnamed device')}${device.online ? '' : t(' · 离线', ' · Offline')}`,
                  disabled: !device.online,
                })),
              ]}
              ariaLabel={t('选择目标设备', 'Select target device')}
              disabled={busy || locked}
            />
          </div>
          <label className="field">
            {t('工作目录（可选）', 'Working directory (optional)')}
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} disabled={busy || locked} placeholder={t('留空使用设备默认工作目录', 'Leave empty to use device default')} />
          </label>
          {targetHasPrimary ? (
            <label className="field checkbox-field">
              <input type="checkbox" checked={makePrimary} disabled={busy || locked} onChange={(e) => setMakePrimary(e.target.checked)} />
              <span>{t('替换该设备的主 Bot', 'Replace primary bot on this device')}</span>
            </label>
          ) : null}
        </div>
      </details>
      {error ? (
        <InlineBanner compact tone="danger" title={error} />
      ) : null}
      <ActionBar align="end" className="form-actions">
        {onCancel ? (
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            {t('取消', 'Cancel')}
          </button>
        ) : null}
        <button type="submit" className="primary-button" disabled={busy || locked || !api.transportConnected}>
          {busy ? t('正在创建…', 'Creating…') : t('创建 Bot', 'Create bot')}
        </button>
      </ActionBar>
    </form>
  );
}

interface FrozenGroupCreateAttempt {
  requestId: string;
  targetDeviceId: string;
  title?: string;
  members: MessageMember[];
}

function CreateGroupForm({
  api,
  currentDeviceId,
  devices,
  bots,
  writeTargetApiMap,
  frozenAttempt,
  onFreezeAttempt,
  onCreated,
  onRequestCreateBot,
  onCancel,
}: {
  api: DesktopPanelApi;
  currentDeviceId: string;
  devices: readonly DevicesDirectoryItem[];
  bots: readonly BotDirectoryEntry[];
  writeTargetApiMap: ReadonlyMap<string, DesktopPanelApi>;
  frozenAttempt: FrozenGroupCreateAttempt | null;
  onFreezeAttempt: (attempt: FrozenGroupCreateAttempt | null) => void;
  onCreated: (targetDeviceId: string, scope: ScopeInfo) => void;
  onRequestCreateBot: () => void;
  onCancel?: () => void;
}) {
  const t = useText();
  const [title, setTitle] = useState(() => frozenAttempt?.title ?? '');
  const [members, setMembers] = useState<MessageMember[]>(() => frozenAttempt?.members ?? []);
  const [memberQuery, setMemberQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const sendingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const candidates = useMemo(() => bots.filter((b) => !b.archivedAt), [bots]);
  const devById = useMemo(() => new Map(devices.map((d) => [d.deviceId, d])), [devices]);

  const filteredCandidates = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((b) => {
      const devName = devById.get(b.deviceId)?.displayName || b.deviceName || '';
      return (
        b.role.toLowerCase().includes(q) ||
        devName.toLowerCase().includes(q) ||
        (b.description ?? '').toLowerCase().includes(q)
      );
    });
  }, [candidates, devById, memberQuery]);

  const activeMembers = frozenAttempt ? frozenAttempt.members : members;

  function resolveWriteApi(deviceId: string): DesktopPanelApi | null {
    const mapped = writeTargetApiMap.get(deviceId);
    if (mapped?.transportConnected && mapped.identity) return mapped;
    if (!api.transportConnected || !api.identity) return null;
    if (api.identity.kind === 'local' && api.identity.targetDeviceId !== deviceId) return null;
    if (!devById.get(deviceId)?.online) return null;
    try {
      return targetApi(api, deviceId, true);
    } catch {
      return null;
    }
  }

  function pickAuthorityDeviceId(selectedMembers: readonly MessageMember[]): string {
    if (
      currentDeviceId &&
      selectedMembers.some((m) => m.deviceId === currentDeviceId) &&
      resolveWriteApi(currentDeviceId)
    ) {
      return currentDeviceId;
    }
    for (const member of selectedMembers) {
      if (resolveWriteApi(member.deviceId)) return member.deviceId;
    }
    return '';
  }

  function toggleMember(bot: { deviceId: string; botId: string }) {
    if (busy || frozenAttempt) return;
    setError(null);
    setMembers((prev) => {
      const exists = prev.some((m) => m.botId === bot.botId);
      if (exists) return prev.filter((m) => m.botId !== bot.botId);
      if (prev.length >= 64) return prev;
      return [...prev, { deviceId: bot.deviceId, botId: bot.botId }];
    });
  }

  async function submit() {
    if (sendingRef.current || busy) return;
    let attempt = frozenAttempt;
    if (!attempt) {
      if (members.length < 2) {
        setError('群聊至少需要选择 2 个 Bot。');
        return;
      }
      if (members.length > 64) {
        setError('群聊最多支持 64 个成员。');
        return;
      }
      const trimmedTitle = title.trim();
      if ([...trimmedTitle].length > 120) {
        setError('群名称最多 120 个字符。');
        return;
      }
      const targetDeviceId = pickAuthorityDeviceId(members);
      if (!targetDeviceId) {
        setError('所选成员所在设备当前均离线或未连接，请至少包含一位在线设备上的 Bot。');
        return;
      }
      attempt = {
        requestId: crypto.randomUUID(),
        targetDeviceId,
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        members: members.map((m) => ({ deviceId: m.deviceId, botId: m.botId })),
      };
    }

    const wApi = resolveWriteApi(attempt.targetDeviceId);
    const wIdentity = wApi?.identity;
    if (!wApi || !wIdentity || !wApi.transportConnected) {
      setError(
        frozenAttempt
          ? '目标设备当前未连接或离线，请恢复连接后再按原请求重试。'
          : '目标设备当前未连接或离线，请恢复连接后再试。',
      );
      return;
    }

    sendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const scope = await wApi.mutateIntent(wIdentity, 'createScope', {
        input: {
          requestId: attempt.requestId,
          kind: 'room',
          members: attempt.members,
          ...(attempt.title ? { title: attempt.title } : {}),
        },
      });
      if (!mountedRef.current) return;
      onFreezeAttempt(null);
      setTitle('');
      setMembers([]);
      setMemberQuery('');
      onCreated(attempt.targetDeviceId, scope);
    } catch (e) {
      if (!mountedRef.current) return;
      const responded =
        Boolean(e && typeof e === 'object' && (e as { outcome?: string }).outcome === 'responded');
      if (isNotSent(e) || responded) {
        onFreezeAttempt(null);
        setError(errText(e));
      } else {
        onFreezeAttempt(attempt);
        setError(
          `${errText(e)}（结果尚未确认，已保留原建群内容，可按原请求安全重试）`,
        );
      }
      reportUnlessTargetOffline(api, e);
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <form
      className="form-grid create-group-form"
      style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
    >
      {frozenAttempt ? (
        <InlineBanner
          compact
          tone="attention"
          role="status"
          className="create-group-freeze-banner"
          title={t('上次建群结果尚未确认', 'Previous group request unconfirmed')}
          detail={t('已保留原建群内容与成员列表，按原请求重试不会重复建群。', 'Request ID and members are frozen for safe retry without creating duplicates.')}
          actions={
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                onFreezeAttempt(null);
                setError(null);
              }}
            >
              {t('放弃并重新编辑', 'Discard and edit again')}
            </button>
          }
        />
      ) : null}

      <label className="field">
        {t('群名称（可选）', 'Group name (optional)')}
        <input
          value={frozenAttempt ? frozenAttempt.title ?? '' : title}
          onChange={(e) => {
            setError(null);
            setTitle(e.target.value);
          }}
          maxLength={120}
          disabled={busy || Boolean(frozenAttempt)}
          placeholder={t('留空则按成员名称自动生成', 'Leave empty to generate from member names')}
          autoFocus
        />
      </label>

      <div className="field">
        <span>{t(`选择成员（已选 ${activeMembers.length} 位，至少 2 位）`, `Select members (${activeMembers.length} selected, minimum 2)`)}</span>
        {activeMembers.length > 0 ? (
          <div className="create-group-chips">
            {activeMembers.map((member) => {
              const matched = bots.find(
                (b) => b.deviceId === member.deviceId && b.botId === member.botId,
              );
              const label = matched?.role || member.botId;
              return (
                <button
                  key={`${member.deviceId}:${member.botId}`}
                  type="button"
                  className="create-group-chip"
                  disabled={busy || Boolean(frozenAttempt)}
                  onClick={() => toggleMember(member)}
                  aria-label={t(`移除 ${label}`, `Remove ${label}`)}
                >
                  {matched ? (
                    <GrokBotAvatar
                      botKey={botAvatarKey(matched)}
                      roleName={matched.role}
                      isPrimary={matched.isPrimary}
                      size={20}
                    />
                  ) : null}
                  <span className="create-group-chip-name">{label}</span>
                  {!frozenAttempt ? <X size={13} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {candidates.length > 4 ? (
          <div className="create-group-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={memberQuery}
              onChange={(e) => setMemberQuery(e.target.value)}
              placeholder={t('搜索 Bot 或设备…', 'Search bots or devices…')}
              aria-label={t('搜索 Bot 或设备', 'Search bots or devices')}
              disabled={busy}
            />
            {memberQuery ? (
              <button
                type="button"
                className="icon-button"
                onClick={() => setMemberQuery('')}
                aria-label={t('清除搜索', 'Clear search')}
              >
                <X size={13} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}

        {candidates.length < 2 ? (
          <div className="empty-state create-group-empty">
            <p>{t('群聊至少需要 2 个未归档 Bot，当前数量不足。', 'At least 2 active bots are required to create a group.')}</p>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={onRequestCreateBot}
            >
              <Plus size={14} aria-hidden="true" /> {t('去新建 Bot', 'Create bot')}
            </button>
          </div>
        ) : filteredCandidates.length === 0 ? (
          <div className="empty-state create-group-empty">{t('没有匹配的 Bot。', 'No matching bots.')}</div>
        ) : (
          <div className="create-group-bot-list" role="group" aria-label={t('可选 Bot', 'Available bots')}>
            {filteredCandidates.map((bot) => {
              const selected = activeMembers.some((m) => m.botId === bot.botId);
              const dev = devById.get(bot.deviceId);
              const deviceLabel = dev?.displayName || bot.deviceName || t('未命名设备', 'Unnamed device');
              const botOnline = Boolean(api.transportConnected && dev?.online && bot.online);
              return (
                <button
                  key={`${bot.deviceId}:${bot.botId}`}
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  disabled={busy || Boolean(frozenAttempt)}
                  className={`create-group-bot-row${selected ? ' selected' : ''}`}
                  onClick={() => toggleMember(bot)}
                >
                  <GrokBotAvatar
                    botKey={botAvatarKey(bot)}
                    roleName={bot.role}
                    isPrimary={bot.isPrimary}
                    starBadge={bot.isPrimary}
                    platformBadge={dev?.platform || bot.platform || 'host'}
                    offline={!botOnline}
                    size={36}
                  />
                  <span className="create-group-bot-info">
                    <span className="create-group-bot-title">
                      <span className="create-group-bot-name">{bot.role}</span>
                      <span className={`create-group-bot-node${botOnline ? '' : ' offline'}`}>
                        {deviceLabel}
                        {botOnline ? '' : t(' · 离线', ' · Offline')}
                      </span>
                    </span>
                    {bot.description ? (
                      <span className="create-group-bot-desc">{bot.description}</span>
                    ) : null}
                  </span>
                  <span className={`create-group-check${selected ? ' selected' : ''}`} aria-hidden="true">
                    {selected ? <Check size={13} strokeWidth={3} /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <p className="hint">{t('可跨设备组合 Bot 加入同一群聊；所选成员中至少需包含一位在线设备上的 Bot。', 'You can combine bots across devices; at least one selected member must be on an online device.')}</p>

      {error ? (
        <InlineBanner compact tone="danger" title={error} />
      ) : null}

      <ActionBar align="end" className="form-actions">
        {onCancel ? (
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            {t('取消', 'Cancel')}
          </button>
        ) : null}
        <button
          type="submit"
          className="primary-button"
          disabled={
            busy ||
            !api.transportConnected ||
            (!frozenAttempt && activeMembers.length < 2)
          }
        >
          {busy
            ? t('正在创建群聊…', 'Creating group…')
            : frozenAttempt
              ? t('重试创建群聊', 'Retry creating group')
              : activeMembers.length >= 2
                ? t(`创建群聊 (${activeMembers.length})`, `Create group (${activeMembers.length})`)
                : t('创建群聊', 'Create group')}
        </button>
      </ActionBar>
    </form>
  );
}

const SLASH_COMMANDS: ReadonlyArray<{ command: SlashCommandName; label: string; desc: string }> = [
  { command: '/clear', label: '/clear', desc: '清空当前对话历史' },
  { command: '/compact', label: '/compact', desc: '压缩上下文记忆' },
];
type SlashCommandName = '/clear' | '/compact';
/** 与手机端 Host.tsx parseSlashCommand 一致：整段输入精确匹配命令才走控制方法，否则是普通文本。 */
function parseSlashCommand(text: string): SlashCommandName | null {
  const trimmed = text.trim();
  return SLASH_COMMANDS.find((c) => c.command === trimmed)?.command ?? null;
}

type SendNotice = {
  text: string;
  showRecordAction?: boolean;
};

function Composer({ textareaRef, text, onChangeText, files, onRemoveFile, attachments, onRemoveAttachment, attachmentFetcher, onPickImage, hasNativeClipboardImage = false, canPick, onPick, draftError, draftHint, draftConflict, sendState, receiptBusy, sendError, sendNotice, onSend, canSend, disabled, isPreLlm, isLlmRunning, canSteer = false, isStopping, canStop, stopDisabled, onStop, stopButtonRef, onRetryDraft, attempt, recOutcome, onReleaseNotSent, onRetryClearVerified, onAdoptNewerDraft, onAdoptPersistedDraft, turnAdmission, onRetryTurnAdmission, onRestoreTurnAdmission, canRestoreTurnAdmission = false, canCancelTurnAdmission = false, onInsertSlash, onOpenSendRecord, queuedItems, queueBusy, onRecallQueued, onRecallAllQueued, onDiscardQueued, onSteerQueued, isEditingTurn = false, onCancelEditTurn, extraDockItems }: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onChangeText: (v: string) => void;
  files: { name: string; path: string; size: number }[];
  onRemoveFile: (i: number) => void;
  attachments: ImageAttachment[];
  onRemoveAttachment: (i: number) => void;
  attachmentFetcher: AttachmentFetcher | null;
  onPickImage: (input?: File[] | 'clipboard') => void;
  hasNativeClipboardImage?: boolean;
  canPick: boolean;
  onPick: () => void;
  draftError: string | null;
  draftHint: string | null;
  draftConflict: DraftSnapshot | null;
  sendState: 'idle' | 'sending';
  receiptBusy: boolean;
  sendError: string | null;
  /** 发送受理与斜杠命令的提示。 */
  sendNotice: SendNotice | null;
  onSend: (delivery?: TurnDeliveryMode) => void;
  canSend: boolean;
  disabled: boolean;
  isPreLlm: boolean;
  isLlmRunning: boolean;
  canSteer?: boolean;
  isStopping: boolean;
  canStop: boolean;
  stopDisabled: boolean;
  onStop: () => void;
  stopButtonRef: RefObject<HTMLButtonElement | null>;
  onRetryDraft: () => void;
  attempt: { phase: string; error: string | null } | null;
  recOutcome: { action: string; found: boolean; recordId: string | null; recordState: string | null } | null;
  onReleaseNotSent: () => void;
  onRetryClearVerified: () => void;
  onAdoptNewerDraft: () => void;
  onAdoptPersistedDraft?: () => void;
  /** 最新可见的 Host 准入状态（来自原 pending 记录 receipt.admission）；null 表示无等待项。 */
  turnAdmission: TurnAdmissionView | null;
  /** Host 准入失败后的显式重试：沿用冻结的同一 requestId/文本重新入队，不自动重发。 */
  onRetryTurnAdmission: () => void;
  onRestoreTurnAdmission?: () => void;
  canRestoreTurnAdmission?: boolean;
  canCancelTurnAdmission?: boolean;
  /** 斜杠命令先填回输入框；用户显式发送后由发送路径调用 clearHistory/compact，不当作模型 prompt。 */
  onInsertSlash: (command: string) => void;
  onOpenSendRecord?: () => void;
  queuedItems?: readonly UnifiedQueuedStripItem[];
  queueBusy?: boolean;
  onRecallQueued?: (item: UnifiedQueuedStripItem) => void;
  onRecallAllQueued?: () => void;
  onDiscardQueued?: (item: UnifiedQueuedStripItem) => void;
  onSteerQueued?: (item: UnifiedQueuedStripItem) => void;
  isEditingTurn?: boolean;
  onCancelEditTurn?: () => void;
  extraDockItems?: readonly ConditionDockItem[];
}) {
  const t = useText();
  const [slashIndex, setSlashIndex] = useState(0);
  const [dismissedSlash, setDismissedSlash] = useState<string | null>(null);
  const composingRef = useRef(false);

  const autosize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [textareaRef]);

  useLayoutEffect(() => {
    autosize();
  }, [text, autosize]);

  useEffect(() => {
    const row = textareaRef.current?.parentElement;
    if (!row) return;
    let width: number | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      autosize();
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [textareaRef, autosize]);

  const slashMatches = useMemo(() => {
    const firstLine = text.split('\n', 1)[0] ?? '';
    if (!firstLine.startsWith('/')) return [];
    const q = firstLine.slice(1).toLowerCase();
    if (firstLine.includes(' ')) return [];
    return SLASH_COMMANDS.filter((c) => c.label.slice(1).startsWith(q));
  }, [text]);

  const slashOpen = !isEditingTurn && slashMatches.length > 0 && !disabled && dismissedSlash !== text;

  useEffect(() => {
    setSlashIndex(0);
  }, [text]);

  function pickSlash(command: string) {
    setDismissedSlash(command);
    onInsertSlash(command);
    textareaRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (composingRef.current || e.nativeEvent.isComposing) return;
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => Math.min(slashMatches.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSlash(slashMatches[Math.min(slashIndex, slashMatches.length - 1)].command);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedSlash(text);
        return;
      }
    }
    if (e.key === 'Escape' && isEditingTurn && onCancelEditTurn) {
      e.preventDefault();
      onCancelEditTurn();
      return;
    }
    if (
      e.key === 'ArrowUp' &&
      e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !isEditingTurn &&
      queuedItems &&
      queuedItems.length > 0 &&
      onRecallQueued &&
      !queueBusy &&
      !disabled
    ) {
      e.preventDefault();
      const latest = queuedItems[queuedItems.length - 1];
      if (latest) onRecallQueued(latest);
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      if (canSend && !receiptBusy && !disabled && !isPreLlm && !isStopping) {
        onSend(canSteer && !isEditingTurn ? 'steer' : 'followUp');
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend && !receiptBusy && !disabled && !isPreLlm && !isStopping) onSend('followUp');
    }
  }

  const recoveringAttempt = attempt && (attempt.phase === 'not-sent' || attempt.phase === 'failed' ||
    draftConflict || recOutcome?.action === 'ready-clear-retry') ? attempt : null;
  const footerStatus = receiptBusy ? '' : (sendNotice?.text ?? '');
  const footerHint =
    draftHint ??
    (isEditingTurn
      ? 'Enter 重新发送 · Shift+Enter 换行 · Esc 取消编辑'
      : canSteer
        ? 'Enter 排队 · Ctrl+Enter 立即插入 · Shift+Enter 换行'
        : isLlmRunning
          ? 'Enter 排队 · Shift+Enter 换行'
          : 'Enter 发送 · Shift+Enter 换行 · / 呼出命令');
  const footerRecordAction = sendState === 'idle' && sendNotice?.showRecordAction &&
    !recoveringAttempt && !sendError
    ? onOpenSendRecord
    : undefined;
  const hasDraftContent = text.trim().length > 0 || attachments.length > 0;

  const composerPlusMenuItems = useMemo<PopoverMenuItem[]>(() => {
    const items: PopoverMenuItem[] = [];
    if (canPick) {
      items.push({
        key: 'pick-file',
        label: '添加本地路径引用',
        icon: <FileText size={16} aria-hidden="true" />,
        disabled,
        onSelect: onPick,
      });
    }
    items.push({
      key: 'pick-image',
      label: '添加图片',
      icon: <ImageIcon size={16} aria-hidden="true" />,
      disabled: disabled || attachments.length >= IMAGE_MAX_COUNT,
      onSelect: () => onPickImage(),
    });
    if (!canPick && !isEditingTurn) {
      items.push({
        key: 'local-path-note',
        label: '本地路径仅本机设备可用',
        icon: <FileText size={16} aria-hidden="true" />,
        disabled: true,
        separatorBefore: true,
        onSelect: () => {},
      });
    }
    return items;
  }, [canPick, disabled, onPick, attachments.length, onPickImage, isEditingTurn]);

  const dockItems = useMemo<ConditionDockItem[]>(() => {
    const items: ConditionDockItem[] = [...(extraDockItems ?? [])];

    if (recoveringAttempt) {
      const conflictPreview = draftConflict
        ? `磁盘上的新版草稿：${truncate(draftConflict.text, 160) || '（空文本）'}${draftConflict.files.length > 0 ? `（${draftConflict.files.length} 个文件引用）` : ''}`
        : undefined;
      items.push({
        id: 'draft-recovery',
        priority: 100,
        tone: 'danger',
        label: recoveringAttempt.phase === 'not-sent' ? '消息未入队' : '草稿待处理',
        collapsible: false,
        render: () => (
          <InlineBanner
            compact
            tone="danger"
            role="alert"
            title={
              recoveringAttempt.phase === 'not-sent'
                ? (sendError ?? recoveringAttempt.error ?? '消息尚未入队。')
                : (sendError ?? recoveringAttempt.error ?? '草稿需要处理。')
            }
            detail={conflictPreview}
            actions={
              recoveringAttempt.phase === 'not-sent' ? (
                <button type="button" className="secondary-button" onClick={onReleaseNotSent}>
                  恢复编辑
                </button>
              ) : (
                <>
                  {onOpenSendRecord ? (
                    <button type="button" className="secondary-button" onClick={onOpenSendRecord}>
                      查看发送记录
                    </button>
                  ) : null}
                  {draftConflict && recOutcome?.found ? (
                    <button type="button" className="secondary-button" onClick={onAdoptNewerDraft}>
                      保留新版草稿，结束旧尝试
                    </button>
                  ) : null}
                  {recOutcome?.action === 'ready-clear-retry' ? (
                    <button type="button" className="secondary-button" onClick={onRetryClearVerified}>
                      重试本地清空
                    </button>
                  ) : null}
                </>
              )
            }
          />
        ),
      });
    } else if (draftConflict) {
      items.push({
        id: 'draft-conflict',
        priority: 96,
        tone: 'attention',
        label: '草稿冲突',
        collapsible: false,
        render: () => (
          <InlineBanner
            compact
            tone="attention"
            role="status"
            title="发现磁盘上的新版草稿"
            detail={`${truncate(draftConflict.text, 160) || '（空文本）'}${draftConflict.files.length > 0 ? `（${draftConflict.files.length} 个文件引用）` : ''}`}
            actions={
              <>
                {onAdoptPersistedDraft ? (
                  <button type="button" className="secondary-button" onClick={onAdoptPersistedDraft}>
                    采用新版草稿
                  </button>
                ) : null}
                <button type="button" className="secondary-button" onClick={onRetryDraft}>
                  保留当前输入
                </button>
              </>
            }
          />
        ),
      });
    }

    if (turnAdmission?.phase === 'failed') {
      const isNoVision = turnAdmission.error?.code === 'MODEL_NO_VISION';
      items.push({
        id: 'turn-admission-failed',
        priority: 95,
        tone: isNoVision ? 'attention' : 'danger',
        label: isNoVision ? '不支持图片输入' : '消息未开始处理',
        collapsible: false,
        render: () =>
          isNoVision ? (
            <ErrorNotice
              tone="warning"
              title="当前模型不支持图片输入"
              description="该消息包含图片附件，请切换支持视觉的模型后重试，或恢复到输入框修改/移除图片后再发。"
              detail={`${turnAdmission.error?.code ?? 'MODEL_NO_VISION'}: ${turnAdmission.error?.message ?? ''}`}
              actionLabel="重试发送"
              onAction={onRetryTurnAdmission}
              secondaryActionLabel={canRestoreTurnAdmission && onRestoreTurnAdmission ? '恢复编辑' : canCancelTurnAdmission ? '取消' : undefined}
              onSecondaryAction={canRestoreTurnAdmission && onRestoreTurnAdmission ? onRestoreTurnAdmission : canCancelTurnAdmission ? onStop : undefined}
              compact
            />
          ) : (
            <ErrorNotice
              title="消息暂未开始处理"
              description="内容已保留，可以重试。"
              detail={turnAdmission.error ? `${turnAdmission.error.code}: ${turnAdmission.error.message ?? ''}` : undefined}
              actionLabel="重试发送"
              onAction={onRetryTurnAdmission}
              secondaryActionLabel={canRestoreTurnAdmission && onRestoreTurnAdmission ? '恢复编辑' : canCancelTurnAdmission ? '取消' : undefined}
              onSecondaryAction={canRestoreTurnAdmission && onRestoreTurnAdmission ? onRestoreTurnAdmission : canCancelTurnAdmission ? onStop : undefined}
              compact
            />
          ),
      });
    }

    if (draftError) {
      items.push({
        id: 'draft-error',
        priority: 85,
        tone: 'danger',
        label: '草稿保存失败',
        defaultExpanded: true,
        render: () => (
          <ErrorNotice error={draftError} actionLabel="重试保存" onAction={onRetryDraft} compact />
        ),
      });
    }

    if (sendError && !attempt) {
      items.push({
        id: 'send-error',
        priority: 82,
        tone: 'danger',
        label: '发送失败',
        defaultExpanded: true,
        render: () => (
          <ErrorNotice
            error={sendError}
            actionLabel={onOpenSendRecord ? '查看发送记录' : undefined}
            onAction={onOpenSendRecord}
            compact
          />
        ),
      });
    }

    if (isEditingTurn && onCancelEditTurn) {
      items.push({
        id: 'edit-turn',
        priority: 45,
        tone: 'info',
        label: '编辑历史消息',
        collapsible: false,
        render: () => (
          <ComposerEditBanner
            disabled={disabled || receiptBusy}
            onCancel={onCancelEditTurn}
          />
        ),
      });
    } else if (queuedItems && queuedItems.length > 0 && onRecallQueued && onRecallAllQueued && onDiscardQueued) {
      items.push({
        id: 'pending-queue',
        priority: 30,
        tone: 'neutral',
        label: '排队消息',
        badge: queuedItems.length,
        defaultExpanded: true,
        render: () => (
          <PendingQueueStrip
            items={queuedItems}
            disabled={Boolean(queueBusy || disabled || isStopping)}
            canSteer={canSteer}
            onRecall={onRecallQueued}
            onRecallAll={onRecallAllQueued}
            onDiscard={onDiscardQueued}
            onSteer={canSteer ? onSteerQueued : undefined}
          />
        ),
      });
    }

    return items;
  }, [
    extraDockItems,
    recoveringAttempt,
    draftConflict,
    sendError,
    onReleaseNotSent,
    onOpenSendRecord,
    recOutcome?.found,
    recOutcome?.action,
    onAdoptNewerDraft,
    onAdoptPersistedDraft,
    onRetryClearVerified,
    turnAdmission,
    onRetryTurnAdmission,
    canRestoreTurnAdmission,
    onRestoreTurnAdmission,
    canCancelTurnAdmission,
    onStop,
    draftError,
    onRetryDraft,
    attempt,
    isEditingTurn,
    onCancelEditTurn,
    disabled,
    receiptBusy,
    queuedItems,
    queueBusy,
    isStopping,
    canSteer,
    onRecallQueued,
    onRecallAllQueued,
    onDiscardQueued,
    onSteerQueued,
  ]);

  return (
    <div className="composer bot-composer">
      <ConditionDock items={dockItems} className="bot-condition-dock" />
      {files.length > 0 || attachments.length > 0 ? (
        <div className="composer-extras">
          {files.length > 0 ? (
            <>
              <p className="hint">已引用 {files.length} 个路径，发送时按原文引用，不会上传文件。</p>
              <div className="file-refs">
                {files.map((f, i) => (
                  <span key={`${f.path}#${i}`} className="file-ref" title={f.path}>
                    <FileText size={12} aria-hidden="true" />
                    {f.name} · {f.size} B
                    <button type="button" onClick={() => onRemoveFile(i)} disabled={disabled} aria-label={`移除 ${f.name}`}>
                      <X size={12} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            </>
          ) : null}
          {attachments.length > 0 ? (
            <div className="attachments" role="group" aria-label="图片附件">
              {attachments.map((att, i) => (
                <ImageAttachmentThumb
                  key={att.id}
                  attachment={att}
                  fetcher={attachmentFetcher}
                  disabled={disabled}
                  onRemove={() => onRemoveAttachment(i)}
                  t={(zh, en) => zh}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="composer-input-wrap">
        {slashOpen ? (
          <div className="slash-popover" role="listbox" aria-label="斜杠命令">
            {slashMatches.map((c, i) => (
              <button
                key={c.command}
                type="button"
                role="option"
                aria-selected={i === slashIndex}
                className={`slash-option${i === slashIndex ? ' active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSlash(c.command);
                }}
              >
                <span className="slash-cmd">{c.label}</span>
                <span className="slash-desc">{c.desc}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="composer-row">
          <PopoverMenu
            align="start"
            side="top"
            ariaLabel={t('添加附件', 'Add attachment')}
            items={composerPlusMenuItems}
            trigger={({ triggerProps }) => (
              <button
                {...triggerProps}
                type="button"
                className="icon-button composer-plus"
                disabled={disabled}
                aria-label={t('添加附件', 'Add attachment')}
                title={t('添加附件', 'Add attachment')}
              >
                <Plus size={18} aria-hidden="true" />
              </button>
            )}
          />
          <textarea
            ref={textareaRef}
            className="composer-input"
            value={text}
            onChange={(e) => onChangeText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const decision = decideImagePasteAction(e.clipboardData, {
                isDesktopLinux: isDesktopLinuxPlatform(),
                hasNativeClipboard: hasNativeClipboardImage,
              });
              if (decision.files.length > 0) {
                if (decision.preventDefault) {
                  e.preventDefault();
                }
                onPickImage(decision.files);
                return;
              }
              if (decision.useNativeClipboardFallback) {
                onPickImage('clipboard');
              }
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            aria-label={isEditingTurn ? '编辑历史消息' : '输入消息'}
            placeholder={isEditingTurn ? '编辑消息内容…' : '输入消息，/ 呼出命令…'}
            rows={1}
            disabled={disabled}
          />
          {isStopping ? (
            <button
              ref={stopButtonRef}
              type="button"
              className="composer-stop"
              disabled
              aria-label="正在停止…"
              title="正在停止…"
            >
              <RefreshCw size={15} className="grok-spin" aria-hidden="true" />
            </button>
          ) : isPreLlm || receiptBusy ? null : isLlmRunning ? (
            <>
              {canSteer && hasDraftContent && !isEditingTurn ? (
                <button
                  type="button"
                  className="composer-steer"
                  onClick={() => onSend('steer')}
                  disabled={receiptBusy || disabled || !canSend || isPreLlm || isStopping}
                  aria-label="打断并立即发送"
                  title="打断并立即发送 (Ctrl+Enter)"
                >
                  <Zap size={14} aria-hidden="true" />
                </button>
              ) : null}
              {hasDraftContent || !canStop ? (
                <button
                  type="button"
                  className="composer-send primary-button"
                  onClick={() => onSend('followUp')}
                  disabled={receiptBusy || disabled || !canSend || isPreLlm || isStopping}
                  aria-label="排队发送"
                  title={canSteer ? 'Enter 排队发送 · Ctrl+Enter 立即插入' : 'Enter 排队发送'}
                >
                  <SendButtonIcon busy={false} size={16} />
                </button>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              className="composer-send primary-button"
              onClick={() => onSend('followUp')}
              disabled={receiptBusy || disabled || !canSend || isPreLlm || isStopping}
              aria-label={isEditingTurn ? '重新发送' : '发送'}
              title={isEditingTurn ? 'Enter 重新发送 · Esc 取消编辑' : 'Enter 发送 · Shift+Enter 换行'}
            >
              <SendButtonIcon busy={false} size={16} />
            </button>
          )}
          {!isStopping && !receiptBusy && canStop ? (
            <button
              ref={stopButtonRef}
              type="button"
              className="composer-stop"
              onClick={onStop}
              disabled={stopDisabled}
              aria-label="停止此 Bot"
              title="停止当前执行并将排队消息撤回输入框"
            >
              <Square size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="composer-footer">
        <div className="composer-footer-text" title={footerStatus || footerHint}>
          <span role="status">{footerStatus}</span>
          {footerStatus ? null : footerHint}
        </div>
        {footerRecordAction ? (
          <button type="button" className="composer-record-link" onClick={footerRecordAction}>打开发送记录</button>
        ) : null}
      </div>
    </div>
  );
}

function BotProfile({ api, centerApi, bot, page, onSaved }: {
  api: DesktopPanelApi;
  centerApi: DesktopPanelApi;
  bot: BotRecord;
  page: 'profile' | 'management';
  onSaved: (bot: BotRecord) => void;
}) {
  const t = useText();
  const [name, setName] = useState(bot.role);
  const [description, setDescription] = useState(bot.description ?? '');
  const [cwd, setCwd] = useState(bot.cwd);
  const [cwdRevision, setCwdRevision] = useState<number | null>(null);
  const [cwdFailed, setCwdFailed] = useState(false);
  const [cwdNotice, setCwdNotice] = useState<string | null>(null);
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [cwdOpened, setCwdOpened] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [cwdBusy, setCwdBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);
  const profileInFlight = useRef(false);
  const cwdInFlight = useRef(false);
  const mountedRef = useRef(true);
  const profileSavedTimerRef = useRef<number | null>(null);
  const dirty = useRef(false);
  const cwdDirty = useRef(false);
  const cwdFetchRef = useRef(0);
  // 最近一次中心权威（或回退）值：编辑比对基准，不以目录侧旧值判定变化。
  const cwdBaseline = useRef(bot.cwd);
  const isArchived = Boolean(bot.archivedAt);
  // cwd 读写走中心 api（broker ops 不需要目标 Host 在线）；profile 仍用 scopedApi。
  const centerOnline = centerApi.transportConnected;
  const centerSess = sessionKey(centerApi.identity);
  const shouldLoadCwd = cwdOpened || page === 'management';

  const clearProfileSavedTimer = useCallback(() => {
    if (profileSavedTimerRef.current !== null) {
      window.clearTimeout(profileSavedTimerRef.current);
      profileSavedTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearProfileSavedTimer();
    };
  }, [clearProfileSavedTimer]);

  useEffect(() => {
    if (page === 'management') setCwdOpened(true);
  }, [page]);
  useEffect(() => {
    if (!dirty.current && !locked) { setName(bot.role); setDescription(bot.description ?? ''); }
    if (!cwdDirty.current) setCwd(bot.cwd);
  }, [bot.role, bot.description, bot.cwd, locked]);
  // bot.cwd 变化（目录合并中心值）时同步基准。
  useEffect(() => {
    if (!cwdDirty.current) cwdBaseline.current = bot.cwd;
  }, [bot.cwd]);

  // 中心权威 cwd 读取；identity/目标在 effect 入口快照，迟到结果被 fetchRef 丢弃。
  const loadCwd = useCallback(async () => {
    const fetchId = ++cwdFetchRef.current;
    const identity = centerApi.identity;
    if (!identity || !centerApi.transportConnected) {
      setCwdRevision(null);
      setCwdFailed(false);
      return;
    }
    try {
      const config = await centerApi.broker(identity, 'center_bot_cwd_get', { deviceId: bot.deviceId, botId: bot.botId });
      if (!mountedRef.current || cwdFetchRef.current !== fetchId) return;
      setCwdRevision(config.revision);
      setCwdFailed(false);
      setCwdError(null);
      if (!cwdDirty.current) setCwd(config.value ?? bot.cwd);
      cwdBaseline.current = config.value ?? bot.cwd;
    } catch {
      if (!mountedRef.current || cwdFetchRef.current !== fetchId) return;
      setCwdRevision(null);
      setCwdFailed(true);
    }
  }, [centerApi, bot.deviceId, bot.botId, bot.cwd]);
  const loadCwdRef = useRef(loadCwd);
  useEffect(() => { loadCwdRef.current = loadCwd; }, [loadCwd]);

  // 管理页首次打开时读取修订。抽屉内切页保留草稿，目标或会话改变时重置。
  const cwdIdentity = bot.botId + '@' + bot.deviceId;
  const lastIdentityRef = useRef('');
  useEffect(() => {
    const identityKey = cwdIdentity + '|' + centerSess;
    const changed = lastIdentityRef.current !== identityKey;
    lastIdentityRef.current = identityKey;
    if (changed) {
      cwdDirty.current = false;
      cwdBaseline.current = bot.cwd;
      setCwdNotice(null);
      setCwdError(null);
      setCwd(bot.cwd);
    }
    // 修订一律作废再重读：同会话重连、身份切换、离开/挂载都会先失效旧请求。
    cwdFetchRef.current++;
    setCwdRevision(null);
    setCwdFailed(false);
    if (shouldLoadCwd) void loadCwdRef.current();
    return () => { cwdFetchRef.current++; };
  }, [cwdIdentity, centerSess, centerOnline, shouldLoadCwd]);

  async function save() {
    const identity = api.identity;
    if (!identity || !api.transportConnected || profileInFlight.current || locked || isArchived) return;
    if (!name.trim()) { setError(t('智能体名称必填', 'Bot name is required')); return; }
    profileInFlight.current = true;
    setProfileBusy(true);
    setError(null);
    try {
      const updated = await api.call(identity, 'updateBotProfile', { botId: bot.botId, name: name.trim(), description: description.trim() });
      if (!mountedRef.current || sessionKey(api.identity) !== sessionKey(identity)) return;
      dirty.current = false;
      setName(updated.role);
      setDescription(updated.description ?? '');
      clearProfileSavedTimer();
      setProfileSaved(true);
      profileSavedTimerRef.current = window.setTimeout(() => {
        profileSavedTimerRef.current = null;
        if (mountedRef.current) setProfileSaved(false);
      }, 2000);
      onSaved(updated);
    } catch (e) {
      if (!mountedRef.current || sessionKey(api.identity) !== sessionKey(identity)) return;
      if (!isNotSent(e) && !(e && typeof e === 'object' && (e as { outcome?: string }).outcome === 'responded')) setLocked(true);
      setError(t(`资料保存失败：${errText(e)}。结果未确认时请读取并采用远端资料核对，不会自动重发。`, `Failed to save profile: ${errText(e)}. When unconfirmed, reload remote profile to verify; it will not auto-retry.`));
    } finally {
      profileInFlight.current = false;
      if (mountedRef.current) setProfileBusy(false);
    }
  }

  async function adoptRemote() {
    const identity = api.identity;
    if (!identity || !api.transportConnected || profileInFlight.current) return;
    profileInFlight.current = true;
    setProfileBusy(true);
    try {
      const items = await api.call(identity, 'listBots', {});
      if (!mountedRef.current || sessionKey(api.identity) !== sessionKey(identity)) return;
      const fresh = items.find((item) => item.botId === bot.botId);
      if (!fresh) { setError(t('远端没有此 Bot；保留草稿与锁定。', 'Bot not found remotely; draft and lock kept.')); return; }
      dirty.current = false;
      setName(fresh.role);
      setDescription(fresh.description ?? '');
      setLocked(false);
      setError(null);
      onSaved(fresh);
    } catch (e) {
      if (mountedRef.current && sessionKey(api.identity) === sessionKey(identity)) {
        setError(t(`读取远端资料失败：${errText(e)}；保留草稿与锁定。`, `Failed to load remote profile: ${errText(e)}; draft and lock kept.`));
      }
    } finally {
      profileInFlight.current = false;
      if (mountedRef.current) setProfileBusy(false);
    }
  }

  const trimmedCwd = cwd.trim();
  const cwdChanged = trimmedCwd !== cwdBaseline.current && trimmedCwd !== '';
  const cwdSavable = cwdChanged && cwdRevision !== null;

  async function saveCwd() {
    const identity = centerApi.identity;
    if (!identity || !centerOnline || cwdInFlight.current || isArchived || !cwdSavable) return;
    cwdInFlight.current = true;
    cwdFetchRef.current += 1;
    setCwdBusy(true);
    setCwdError(null);
    setCwdNotice(null);
    try {
      const config = await centerApi.broker(identity, 'center_bot_cwd_set', {
        deviceId: bot.deviceId,
        botId: bot.botId,
        expectedRevision: cwdRevision,
        value: trimmedCwd,
      });
      if (!mountedRef.current || sessionKey(centerApi.identity) !== sessionKey(identity)) return;
      setCwdRevision(config.revision);
      cwdDirty.current = false;
      cwdBaseline.current = config.value ?? trimmedCwd;
      setCwd(config.value ?? trimmedCwd);
      setCwdNotice(t('已保存到中心；目标 Host 空闲后生效，运行中的任务保持原目录，不会移动文件。', 'Saved to center; applies when the target host is idle without moving files.'));
      onSaved({ ...bot, cwd: config.value ?? trimmedCwd });
    } catch (e) {
      if (!mountedRef.current || sessionKey(centerApi.identity) !== sessionKey(identity)) return;
      const code = (e as { code?: string })?.code;
      if (code === 'REVISION_CONFLICT' || code === 'REQUEST_CONFLICT') {
        setCwdRevision(null);
        setCwdError(t('工作目录已被其他修改占用；请重新读取后再保存。', 'Working directory was modified elsewhere; reload before saving.'));
      } else {
        setCwdError(t('工作目录保存失败：', 'Failed to save working directory: ') + errText(e));
      }
    } finally {
      cwdInFlight.current = false;
      if (mountedRef.current) setCwdBusy(false);
    }
  }

  if (page === 'management') return (
    <div className="form-grid inspector-profile-form" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <label className="field">
        {t('工作目录', 'Working directory')}
        <input
          value={cwd}
          disabled={cwdBusy || isArchived}
          placeholder={t('目标设备上的绝对路径', 'Absolute path on target device')}
          onChange={(e) => { cwdDirty.current = true; setCwd(e.target.value); setCwdNotice(null); }}
        />
      </label>
      <p className="hint">
        {centerOnline
          ? t('保存后将在 Bot 空闲时生效。', 'Takes effect when the bot becomes idle.')
          : t('当前未连接中心，暂以只读展示本机工作目录；连接中心后可修改并同步。', 'Not connected to center; showing read-only local path until connected.')}
      </p>
      {cwdNotice ? <div className="status" role="status">{cwdNotice}</div> : null}
      {centerOnline && (cwdError || cwdFailed) ? <ErrorNotice compact error={cwdError ?? t('无法读取工作目录。', 'Unable to read working directory.')} /> : null}
      <ActionBar align="start" className="form-actions">
        <button type="button" className="secondary-button" onClick={() => void saveCwd()} disabled={cwdBusy || isArchived || !centerOnline || !cwdSavable}>
          {cwdBusy ? t('正在保存工作目录…', 'Saving directory…') : t('保存工作目录', 'Save working directory')}
        </button>
        {centerOnline && (cwdFailed || (cwdError && cwdRevision === null)) ? (
          <button type="button" className="secondary-button" disabled={cwdBusy || !centerOnline} onClick={() => void loadCwdRef.current()}>
            {t('重新读取工作目录', 'Reload working directory')}
          </button>
        ) : null}
      </ActionBar>
    </div>
  );

  return (
    <div className="form-grid inspector-profile-form" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <label className="field">
        {t('名称', 'Name')}
        <input
          value={name}
          maxLength={120}
          disabled={profileBusy || locked || isArchived}
          onChange={(e) => { dirty.current = true; clearProfileSavedTimer(); setProfileSaved(false); setName(e.target.value); }}
        />
      </label>
      <label className="field">
        {t('一句话简介', 'Short description')}
        <textarea
          value={description}
          maxLength={2000}
          disabled={profileBusy || locked || isArchived}
          onChange={(e) => { dirty.current = true; clearProfileSavedTimer(); setProfileSaved(false); setDescription(e.target.value); }}
        />
      </label>
      {error ? <ErrorNotice compact error={error} /> : null}
      <ActionBar align="start" className="form-actions">
        {locked ? (
          <button type="button" className="secondary-button" disabled={profileBusy || !api.transportConnected} onClick={() => void adoptRemote()}>
            {t('采用远端资料', 'Adopt remote profile')}
          </button>
        ) : null}
        <button type="button" className="primary-button" onClick={() => void save()} disabled={profileBusy || locked || isArchived || !api.transportConnected}>
          {profileBusy ? t('正在保存资料…', 'Saving profile…') : t('保存资料', 'Save profile')}
        </button>
        {profileSaved ? <span className="status online" role="status">{t('✓ 已保存', '✓ Saved')}</span> : null}
      </ActionBar>
    </div>
  );
}

type InspectorDetail = BotSettingsTab | 'management';
type InspectorTab = 'profile' | InspectorDetail | 'raw' | 'shower' | 'browser' | 'google-setup';

interface InspectorPage {
  id: InspectorDetail;
  label: string;
  Icon: LucideIcon;
}

const inspectorGroups: ReadonlyArray<{ title: string; pages: readonly InspectorPage[] }> = [
  { title: '核心配置', pages: [
    { id: 'model', label: '模型', Icon: Cpu },
    { id: 'soul', label: '人设 (SOUL.md)', Icon: FileText },
    { id: 'skills', label: '技能 (Skills)', Icon: Sparkles },
    { id: 'capabilities', label: '工具扩展 (MCP & 插件)', Icon: Puzzle },
    { id: 'schedules', label: '定时任务', Icon: Clock },
    { id: 'vault', label: '密码凭据', Icon: LockKeyhole },
  ] },
  { title: '更多管理', pages: [
    { id: 'management', label: '工作目录与更多管理', Icon: Settings },
  ] },
];
const inspectorPages = inspectorGroups.flatMap(group => group.pages);

/** 将 ChatTranscript 持久化挂载的 Google Setup portal 节点移入当前挂载的 ConditionDock 面板；ConditionDock 隐藏而非卸载非活动标签，仅在向导结束退出 dock 时才移回隐藏停靠点，消除切换标签/折叠时的焦点与滚动丢失。 */
function GoogleSetupSlotHost({
  slotEl,
  parkingRef,
}: {
  slotEl: HTMLDivElement | null;
  parkingRef: RefObject<HTMLDivElement | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !slotEl) return;
    if (slotEl.parentNode !== host) {
      host.appendChild(slotEl);
    }
    return () => {
      const parking = parkingRef.current;
      if (parking && slotEl.parentNode === host) {
        parking.appendChild(slotEl);
      }
    };
  }, [slotEl, parkingRef]);
  return <div ref={hostRef} className="desktop-google-setup-host" />;
}

function PrimaryChatPane({
  api,
  centerApi,
  bot,
  readScope,
  deviceName,
  devicePlatform,
  onProfileSaved,
  onBotUpdated,
  onBotDeleted,
  onLiveActivity,
  onOpenPrivateChats,
  onOpenSendRecords,
  onOpenCenterAdmin,
  initialClearedThroughEntryId = 0,
  onClearedThroughEntryId,
  focusComposer = false,
  inspectorRequest = null,
  onInspectorRequestConsumed,
  listCollapsed = false,
  onExpandSidebar,
  expandSidebarButtonRef,
  questionnaireRequestId,
  onQuestionnaireFocused,
  transcriptVisible = true,
  centerInterrupted = false,
  pageActive = true,
  chatWorkspaceActive = pageActive,
  knownBots,
  tasks = [],
  taskBots = [],
  taskScopeKey = 'none',
  jumpedTaskId = null,
  jumpedStepId = null,
  waitingTaskOffset = 0,
  returnTaskId = null,
  taskActionFailure = null,
  taskActionRetrying = false,
  onClearTaskQuote,
  onCycleWaitingTask,
  onOpenTask,
  onReturnToTask,
  onRunTaskAction,
  onRetryTaskAction,
  onDismissTaskAction,
}: {
  api: DesktopPanelApi;
  /** 未按目标在线收窄的原 api：仅中心权威操作（cwd get/set）使用。 */
  centerApi: DesktopPanelApi;
  bot: DesktopBotDirectoryEntry | BotRecord;
  readScope: BotReadScope;
  /** 目录侧设备显示名（仅展示）。 */
  deviceName: string;
  /** 目录侧设备平台徽标（DevicesDirectoryItem.platform）；BotRecord 无此字段，缺省回退 host。 */
  devicePlatform?: string;
  onProfileSaved: (bot: BotRecord) => void;
  onBotUpdated: (patch: Partial<DesktopBotDirectoryEntry> & { botId: string }) => void;
  onBotDeleted: (botId: string) => void;
  onLiveActivity?: () => void;
  /** 打开该 Bot 参与的私聊列表（只读，默认不选对话）。 */
  onOpenPrivateChats?: (bot: BotRecord) => void;
  onOpenSendRecords?: (target: SendRecordsTarget) => void;
  onOpenCenterAdmin?: (tab?: CenterAdminTab) => void;
  initialClearedThroughEntryId?: number;
  onClearedThroughEntryId?: (cutoff: number) => void;
  focusComposer?: boolean;
  inspectorRequest?: { tab: InspectorTab; seq: number } | null;
  onInspectorRequestConsumed?: (seq: number) => void;
  listCollapsed?: boolean;
  onExpandSidebar?: () => void;
  expandSidebarButtonRef?: RefObject<HTMLButtonElement | null>;
  questionnaireRequestId?: string;
  onQuestionnaireFocused?: (id: string) => void;
  transcriptVisible?: boolean;
  centerInterrupted?: boolean;
  pageActive?: boolean;
  chatWorkspaceActive?: boolean;
  knownBots?: readonly KnownBotSummary[];
  tasks?: GlobalTask[];
  taskBots?: TaskBotOption[];
  taskScopeKey?: string;
  jumpedTaskId?: string | null;
  jumpedStepId?: string | null;
  waitingTaskOffset?: number;
  returnTaskId?: string | null;
  taskActionFailure?: PendingTaskChatAction | null;
  taskActionRetrying?: boolean;
  onClearTaskQuote?: () => void;
  onCycleWaitingTask?: () => void;
  onOpenTask?: (taskId: string, openEdit?: boolean) => void;
  onReturnToTask?: (taskId: string) => void;
  onRunTaskAction?: (action: PendingTaskChatActionInput, options?: { rethrow?: boolean }) => Promise<boolean>;
  onRetryTaskAction?: () => void;
  onDismissTaskAction?: () => void;
}) {
  const t = useText();
  const identity = api.identity;
  const sess = sessionKey(identity);
  const readRevision = useSyncExternalStore(readScope.subscribe, readScope.snapshot);
  const readsActive = readScope.isCurrent(readRevision);
  const onBotDeletedRef = useRef(onBotDeleted);
  onBotDeletedRef.current = onBotDeleted;
  const online = api.transportConnected && readsActive;
  /** 目标离线时带设备/Bot 上下文；其余错误原样 code: message。 */
  const tErr = (e: unknown): string =>
    isTargetOfflineError(e) ? `目标 ${deviceName}（${bot.role}）离线：${errText(e)}` : errText(e);
  const isArchived = Boolean(bot.archivedAt);
  const isPrimary = Boolean(bot.isPrimary);
  const compactOverlay = useInspectorCompact();
  const draftTarget = useMemo(() => ({ kind: 'primary' as const, id: bot.botId }), [bot.botId]);
  const drafts = useDrafts({ api, identity, target: draftTarget });

  const [sendState, setSendState] = useState<'idle' | 'sending'>('idle');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendNotice, setSendNotice] = useState<SendNotice | null>(null);
  const [lastSendRecordId, setLastSendRecordId] = useState<string>();
  const [slashBusy, setSlashBusy] = useState<SlashCommandName | null>(null);
  const [recOutcome, setRecOutcome] = useState<{ action: string; found: boolean; recordId: string | null; recordState: string | null } | null>(null);
  const lockedRef = useRef(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab | null>(null);
  const browserOpen = inspectorTab === 'browser';
  const inspectorWorkspaceVisible = pageActive && chatWorkspaceActive;
  const inspectorWorkspaceVisibleRef = useRef(inspectorWorkspaceVisible);
  inspectorWorkspaceVisibleRef.current = inspectorWorkspaceVisible;
  const inspectorDialogOpen = inspectorWorkspaceVisible && inspectorTab !== null && !browserOpen;
  const browserDialogOpen = inspectorWorkspaceVisible && browserOpen;
  const [browserDestination, setBrowserDestination] = useState<{ scope: string; value: BrowserDestination } | null>(null);
  const browserDestinationScope = `${sess}:${bot.deviceId}:${bot.botId}`;
  const openBrowserDestination = useCallback((value: BrowserDestination) => {
    const activeEl = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (activeEl) browserTriggerRef.current = activeEl;
    setBrowserDestination({ scope: browserDestinationScope, value });
    setInspectorTab('browser');
  }, [browserDestinationScope]);
  useEffect(() => {
    setBrowserDestination(current => inspectorTab === 'browser' && current?.scope === browserDestinationScope ? current : null);
  }, [inspectorTab, browserDestinationScope]);
  const [chatSearch, setChatSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const inspectorTriggerRef = useRef<HTMLElement | null>(null);
  const browserTriggerRef = useRef<HTMLElement | null>(null);
  const confirmTriggerRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const googleSetupSlotEl = useMemo(() => {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.className = 'desktop-google-setup-slot';
    return el;
  }, []);
  const googleSetupParkingRef = useRef<HTMLDivElement | null>(null);
  const [hasGoogleSetupDock, setHasGoogleSetupDock] = useState(false);
  const [googleSetupAttention, setGoogleSetupAttention] = useState(false);
  const [googleSetupBrowserTakeoverActive, setGoogleSetupBrowserTakeoverActive] = useState(false);
  useLayoutEffect(() => {
    const parking = googleSetupParkingRef.current;
    if (parking && googleSetupSlotEl && !googleSetupSlotEl.parentNode) {
      parking.appendChild(googleSetupSlotEl);
    }
  }, [googleSetupSlotEl]);
  useEffect(() => {
    if (!googleSetupSlotEl) return;
    let watchedRoot: Element | null = null;
    const attrObserver = typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          const first = googleSetupSlotEl.firstElementChild;
          setGoogleSetupAttention(Boolean(first?.classList.contains('is-attention')));
        })
      : null;
    const sync = () => {
      const first = googleSetupSlotEl.firstElementChild;
      setHasGoogleSetupDock(Boolean(first));
      setGoogleSetupAttention(Boolean(first?.classList.contains('is-attention')));
      if (attrObserver && first !== watchedRoot) {
        attrObserver.disconnect();
        watchedRoot = first;
        if (first) {
          attrObserver.observe(first, { attributes: true, attributeFilter: ['class'] });
        }
      }
    };
    sync();
    if (typeof MutationObserver !== 'function') return;
    const childObserver = new MutationObserver(sync);
    childObserver.observe(googleSetupSlotEl, { childList: true });
    return () => {
      childObserver.disconnect();
      attrObserver?.disconnect();
    };
  }, [googleSetupSlotEl]);
  const autoFocusedRef = useRef(false);
  /** 本聊天最新的 Host 准入状态（Host-queued 回执中的 admission）；null 表示无等待项。 */
  const [turnAdmission, setTurnAdmission] = useState<TurnAdmissionView | null>(null);
  const lastEditedAdmissionRef = useRef<{
    sess: string;
    botId: string;
    requestId: string;
    text: string;
    attachments: string[];
  } | null>(null);
  /** 抽屉 Portal 容器：回调 ref + state 保证首帧即挂到 stageEl，避免先落 document.body 再跳迁。 */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const setStageRef = useCallback((node: HTMLDivElement | null) => {
    stageRef.current = node;
    setStageEl(node);
  }, []);
  const inspectorContentRef = useRef<HTMLDivElement | null>(null);
  const inspectorBodyRef = useRef<HTMLDivElement | null>(null);
  const inspectorTitleRef = useRef<HTMLHeadingElement | null>(null);
  const previousInspectorTabRef = useRef<InspectorTab | null>(null);
  const profileScrollRef = useRef(0);

  const [manageAction, setManageAction] = useState<'setPrimary' | 'archive' | 'unarchive' | 'delete' | 'clear' | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearDone, setClearDone] = useState(false);
  const initialCutoff = readClearedThroughEntryId(initialClearedThroughEntryId) ?? 0;
  const [clearedThroughEntryId, setClearedThroughEntryId] = useState<number>(initialCutoff);
  const cutoffRef = useRef<number>(initialCutoff);
  const onClearedThroughEntryIdRef = useRef(onClearedThroughEntryId);
  onClearedThroughEntryIdRef.current = onClearedThroughEntryId;
  const onInspectorRequestConsumedRef = useRef(onInspectorRequestConsumed);
  onInspectorRequestConsumedRef.current = onInspectorRequestConsumed;
  const manageInFlightRef = useRef(false);
  const manageBusy = manageAction !== null;
  const [taskBannerBusy, setTaskBannerBusy] = useState(false);

  const resolvedTaskContext = useMemo(
    () =>
      resolveBotChatTaskContext({
        tasks,
        botDeviceId: bot.deviceId,
        botId: bot.botId,
        jumpedTaskId,
        jumpedStepId,
        waitingOffset: waitingTaskOffset,
      }),
    [tasks, bot.deviceId, bot.botId, jumpedTaskId, jumpedStepId, waitingTaskOffset],
  );
  const linkedTask = resolvedTaskContext.linkedTask;
  const focusedStep = resolvedTaskContext.focusedStep;
  const bannerTask = resolvedTaskContext.linkedTask;

  const onLiveActivityRef = useRef(onLiveActivity);
  onLiveActivityRef.current = onLiveActivity;

  /** 问卷提交复用现有 callCapabilityAction；deviceId/botId 取自当前身份与 Bot。 */
  const submitQuestionnaire = useCallback(
    async (installationId: string, input: QuestionnaireSubmitPayload): Promise<unknown> => {
      const current = api.identity;
      if (isArchived || !identity || !current || !api.transportConnected ||
        current.profileId !== identity.profileId || current.targetDeviceId !== identity.targetDeviceId ||
        current.kind !== identity.kind || current.generation !== identity.generation) {
        throw Object.assign(new Error('NOT_CONNECTED: 没有活动连接身份'), { code: 'NOT_CONNECTED' });
      }
      const reply = await api.call(identity, 'callCapabilityAction', {
        installationId,
        action: 'answerQuestionnaire',
        request: {
          requestId: crypto.randomUUID(),
          deviceId: identity.targetDeviceId,
          botId: bot.botId,
          input,
        },
      });
      return reply?.result;
    },
    [api, identity, isArchived, bot.botId],
  );

  // 私有解锁回执绑定当前目标身份，不经过聊天提交或离线待发队列；归档 Bot 严格只读禁止提交。
  const submitVaultUnlock = useCallback((input: VaultUnlockSubmitPayload): Promise<unknown> => {
    const current = api.identity;
    if (isArchived || !identity || !current || !api.transportConnected ||
      current.profileId !== identity.profileId || current.targetDeviceId !== identity.targetDeviceId ||
      current.kind !== identity.kind || current.generation !== identity.generation) {
      return Promise.reject({ code: 'NOT_CONNECTED' });
    }
    return api.call(identity, 'vaultControl', { action: 'respondUnlock', ...input });
  }, [api, identity, isArchived]);

  // Bot 内置浏览器与 Google 建项向导控制：volatile RPC 绑定当前目标设备与 Bot，不经持久 outbox。
  const fallbackCallBrowser = useMemo(
    () => createBrowserControlRequest(api, identity, bot.botId),
    [api, identity, bot.botId],
  );
  const browserProfileId = identity?.profileId;
  const browserDeviceId = identity?.targetDeviceId;
  const browserGeneration = identity?.generation;
  const browserConnectionKind = identity?.kind;
  const browserPlacementKey = browserDeviceId && browserProfileId
    ? `desktop-browser-placement:${JSON.stringify([browserProfileId, browserDeviceId])}`
    : '';
  const [browserPreference, setBrowserPreference] = useState<{ key: string; placement: 'client' | 'server' }>();
  let browserPlacement: 'client' | 'server' = 'client';
  if (browserPreference?.key === browserPlacementKey) {
    browserPlacement = browserPreference.placement;
  } else if (browserPlacementKey) {
    try { if (localStorage.getItem(browserPlacementKey) === 'server') browserPlacement = 'server'; } catch { /* storage may be unavailable */ }
  }
  const setBrowserPlacement = (placement: 'client' | 'server') => {
    setBrowserPreference({ key: browserPlacementKey, placement });
    try { if (browserPlacementKey) localStorage.setItem(browserPlacementKey, placement); } catch { /* retain in memory */ }
  };
  const nativeBrowser = useMemo(
    () => identity && isTauri() && !isArchived && /Windows|Linux/.test(navigator.userAgent)
      ? desktopNativeBrowser(api, identity, bot.botId) : undefined,
    [api, identity, bot.botId, isArchived],
  );
  const [localBrowser, setLocalBrowser] = useState<DesktopNativeBrowser>();
  useEffect(() => {
    if (!nativeBrowser) return;
    let active = true;
    void nativeBrowser.isLocalHost().then(local => {
      if (active) setLocalBrowser(local ? nativeBrowser : undefined);
    });
    return () => { active = false; };
  }, [nativeBrowser, online]);
  useEffect(() => {
    if (nativeBrowser && online && pageActive) void nativeBrowser.prepare(browserPlacement).catch(() => {});
  }, [nativeBrowser, online, pageActive, browserPlacement]);
  const callBrowser = useCallback(
    (input: Record<string, unknown>) => nativeBrowser
      ? nativeBrowser.request(input, browserPlacement)
      : fallbackCallBrowser(input),
    [nativeBrowser, browserPlacement, fallbackCallBrowser],
  );
  const subscribeBrowserFrames = useMemo(() => {
    if (!browserConnectionKind || !browserProfileId || !browserDeviceId || browserGeneration === undefined) return;
    return createBrowserFrameSubscriber(api, {
      kind: browserConnectionKind, profileId: browserProfileId,
      targetDeviceId: browserDeviceId, generation: browserGeneration,
    }, bot.botId);
  }, [api, bot.botId, browserProfileId, browserDeviceId, browserGeneration, browserConnectionKind]);
  const callGoogleSetup = useMemo(
    () => createGoogleSetupControlRequest(api, identity, bot.botId),
    [api, identity, bot.botId],
  );
  const provisionGoogleClient = useMemo(
    () => /Windows/.test(navigator.userAgent) ? nativeBrowser?.provisionGoogleClient.bind(nativeBrowser) : undefined,
    [nativeBrowser],
  );
  const selectGoogleAccount = useCallback(
    async (selection: {
      email: string;
      requestId?: string;
      installationId?: string;
      conversationId?: number;
      cancelled?: boolean;
    }) => {
      const current = api.identity;
      if (!current || !api.transportConnected) {
        throw Object.assign(new Error('NOT_CONNECTED: 没有活动连接身份'), { code: 'NOT_CONNECTED' });
      }
      if (selection.requestId && selection.installationId) {
        const actionInput: Record<string, string | number | boolean> = {
          requestId: selection.requestId,
          account: selection.email,
          cancelled: Boolean(selection.cancelled),
        };
        if (selection.conversationId !== undefined) {
          actionInput.conversationId = selection.conversationId;
        }
        return api.call(current, 'callCapabilityAction', {
          installationId: selection.installationId,
          action: 'selectGoogleAccount',
          request: {
            requestId: crypto.randomUUID(),
            deviceId: current.targetDeviceId,
            botId: bot.botId,
            input: actionInput,
          },
        });
      }
      if (!selection.cancelled && selection.email) {
        const reply = t(`请使用 Google 账号 ${selection.email} 继续处理刚才的请求。`, `Please continue using Google account ${selection.email}.`);
        drafts.editText(drafts.text ? `${drafts.text}\n${reply}` : reply);
      }
      return { selected: selection.email };
    },
    [api, bot.botId, drafts, t],
  );
  const googleContext = useMemo<GoogleChatCardContext>(
    () => ({
      api: centerApi,
      identity: centerApi.identity ?? identity,
      deviceId: bot.deviceId,
      botId: bot.botId,
      botName: bot.role,
      hostLabel: deviceName,
      hostPlatform: devicePlatform,
      isLocalAndroid: false,
      connected: online,
      callGoogleSetup,
      callBrowser,
      onOpenBrowser: () => setInspectorTab('browser'),
      onOpenBrowserDestination: openBrowserDestination,
      provisionGoogleClient,
      onOpenCapabilities: () => setInspectorTab('capabilities'),
      onOpenCenterAdmin: onOpenCenterAdmin ? () => onOpenCenterAdmin('google') : undefined,
      onSelectGoogleAccount: selectGoogleAccount,
    }),
    [
      centerApi,
      identity,
      bot.deviceId,
      bot.botId,
      bot.role,
      deviceName,
      devicePlatform,
      online,
      callGoogleSetup,
      callBrowser,
      openBrowserDestination,
      provisionGoogleClient,
      onOpenCenterAdmin,
      selectGoogleAccount,
    ],
  );
  const toolScopeKey = JSON.stringify([
    identity?.profileId, identity?.targetDeviceId, identity?.kind, identity?.generation,
    bot.botId, bot.primaryConversationId, online,
  ]);

  useEffect(() => {
    setManageError(null);
    setConfirmArchive(false);
    setConfirmDelete(false);
    setConfirmClear(false);
  }, [bot.botId]);

  const lastInspectorSeqRef = useRef(0);
  useEffect(() => {
    if (inspectorRequest && inspectorRequest.seq !== lastInspectorSeqRef.current) {
      lastInspectorSeqRef.current = inspectorRequest.seq;
      setInspectorTab(inspectorRequest.tab);
      onInspectorRequestConsumedRef.current?.(inspectorRequest.seq);
    }
  }, [inspectorRequest]);

  useLayoutEffect(() => {
    const previous = previousInspectorTabRef.current;
    previousInspectorTabRef.current = inspectorTab;
    if (previous === 'management' && inspectorTab !== previous) {
      setConfirmArchive(false);
      setConfirmDelete(false);
      setConfirmClear(false);
    }
    if (!inspectorTab) {
      profileScrollRef.current = 0;
      return;
    }
    const body = inspectorBodyRef.current;
    if (!body || !previous || previous === inspectorTab) return;
    if (inspectorTab === 'profile') {
      body.scrollTop = profileScrollRef.current;
      const trigger = body.querySelector<HTMLButtonElement>(`[data-inspector-page="${previous}"]`);
      (trigger ?? inspectorTitleRef.current)?.focus();
    } else {
      body.scrollTop = 0;
      inspectorTitleRef.current?.focus({ preventScroll: true });
    }
  }, [inspectorTab]);
  /** 统一 Shower 面板的平台无关 RPC 适配：方法名/扁平参数由面板给出，身份仍取当前连接。 */
  const callShower = useCallback(
    (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const current = api.identity;
      if (!current) return Promise.reject(new Error('NOT_CONNECTED: 没有活动连接身份'));
      // 直接从 api 调用同一方法（保留 this 绑定）；方法名由面板限定为六个 Shower 控制方法。
      const rawApi = api as unknown as {
        call: (identity: DesktopIdentity, method: string, params: Record<string, unknown>) => Promise<unknown>;
      };
      return rawApi.call(current, method, params);
    },
    [api],
  );

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const isCurrentSession = useCallback(() =>
    mountedRef.current && sessionKey(api.identity) === sess && readScope.isCurrent(readRevision), [api, sess, readScope, readRevision]);

  async function handleSetPrimary() {
    if (!identity || !online || manageInFlightRef.current || isPrimary || isArchived) return;
    manageInFlightRef.current = true;
    setManageAction('setPrimary');
    setManageError(null);
    try {
      const updated = await api.call(identity, 'setPrimaryBot', { botId: bot.botId });
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      onBotUpdated({
        ...(updated && typeof updated === 'object' ? (updated as Partial<BotRecord>) : {}),
        botId: bot.botId,
        isPrimary: true,
      });
    } catch (e) {
      if (mountedRef.current && sessionKey(api.identity) === sess) {
        setManageError(`设为主 Bot 失败：${tErr(e)}`);
        reportUnlessTargetOffline(api, e);
      }
    } finally {
      manageInFlightRef.current = false;
      if (mountedRef.current) setManageAction(null);
    }
  }

  async function handleArchive() {
    if (!identity || !online || manageInFlightRef.current || isPrimary || isArchived) return;
    manageInFlightRef.current = true;
    setManageAction('archive');
    setManageError(null);
    try {
      const updated = await api.call(identity, 'archiveBot', { botId: bot.botId });
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      const archivedAt =
        updated &&
        typeof updated === 'object' &&
        'archivedAt' in updated &&
        typeof (updated as { archivedAt?: unknown }).archivedAt === 'string'
          ? (updated as { archivedAt: string }).archivedAt
          : new Date().toISOString();
      setConfirmArchive(false);
      onBotUpdated({
        ...(updated && typeof updated === 'object' ? (updated as Partial<BotRecord>) : {}),
        botId: bot.botId,
        archivedAt,
        isPrimary: false,
      });
    } catch (e) {
      if (mountedRef.current && sessionKey(api.identity) === sess) {
        setManageError(t(`归档失败：${tErr(e)}`, `Archive failed: ${tErr(e)}`));
        reportUnlessTargetOffline(api, e);
      }
    } finally {
      manageInFlightRef.current = false;
      if (mountedRef.current) setManageAction(null);
    }
  }

  async function handleUnarchive() {
    if (!identity || !online || manageInFlightRef.current || !isArchived) return;
    manageInFlightRef.current = true;
    setManageAction('unarchive');
    setManageError(null);
    try {
      const updated = await api.call(identity, 'unarchiveBot', { botId: bot.botId });
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      onBotUpdated({
        ...(updated && typeof updated === 'object' ? (updated as Partial<BotRecord>) : {}),
        botId: bot.botId,
        archivedAt: null,
      });
    } catch (e) {
      if (mountedRef.current && sessionKey(api.identity) === sess) {
        setManageError(`恢复失败：${tErr(e)}`);
        reportUnlessTargetOffline(api, e);
      }
    } finally {
      manageInFlightRef.current = false;
      if (mountedRef.current) setManageAction(null);
    }
  }

  async function handleDelete() {
    if (!identity || !online || manageInFlightRef.current || isPrimary) return;
    manageInFlightRef.current = true;
    setManageAction('delete');
    setManageError(null);
    readScope.suspend();
    let deleted = false;
    try {
      await deleteBotAndVerify(
        () => api.call(identity, 'deleteBot', { botId: bot.botId }),
        () => api.call(identity, 'getBot', { botId: bot.botId }),
      );
      deleted = true;
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      setConfirmDelete(false);
      onBotDeleted(bot.botId);
    } catch (e) {
      if (mountedRef.current && sessionKey(api.identity) === sess) {
        setManageError(`删除失败：${tErr(e)}`);
      }
    } finally {
      if (!deleted) readScope.resume();
      manageInFlightRef.current = false;
      if (mountedRef.current) setManageAction(null);
    }
  }

  function applyConfirmedClear(clearBoardKey: string, clearedId: number): boolean {
    chatBoard.invalidate(clearBoardKey);
    if (sessionKey(api.identity) === sess && clearedId > 0) {
      onClearedThroughEntryIdRef.current?.(clearedId);
    }
    if (!mountedRef.current || sessionKey(api.identity) !== sess) return false;
    applyCutoff(clearedId);
    setTurnAdmission(null);
    setConfirmClear(false);
    setSendError(null);
    setManageError(null);
    return true;
  }

  async function handleClearHistory() {
    if (!identity || !online || manageInFlightRef.current || slashBusy !== null || isArchived) return;
    const clearBoardKey = botBoardKey(`${identity.profileId}|${identity.kind}`, identity.targetDeviceId, bot.botId);
    manageInFlightRef.current = true;
    setManageAction('clear');
    setManageError(null);
    setClearDone(false);
    try {
      const result = (await api.call(identity, 'clearHistory', { botId: bot.botId })) as ClearHistoryResult;
      const clearedId = readClearedThroughEntryId(
        (result as { clearedThroughEntryId?: unknown } | null | undefined)?.clearedThroughEntryId,
      ) ?? 0;
      if (!applyConfirmedClear(clearBoardKey, clearedId)) return;
      setClearDone(true);
      void loadRawLatest();
      window.setTimeout(() => {
        if (mountedRef.current) setClearDone(false);
      }, 2200);
    } catch (e) {
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      const { message, isUnknown } = describeClearError('清空对话', e, api.transportConnected, tErr);
      setManageError(message);
      if (isUnknown && api.transportConnected) void loadRawLatest();
      reportUnlessTargetOffline(api, e);
    } finally {
      manageInFlightRef.current = false;
      if (mountedRef.current) setManageAction(null);
    }
  }

  const [editingTurn, setEditingTurn] = useState<{
    sess: string;
    botId: string;
    entryId: number;
    text: string;
    attachments: ImageAttachment[];
  } | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const activeEditing =
    editingTurn && editingTurn.sess === sess && editingTurn.botId === bot.botId
      ? editingTurn
      : null;

  function onChangeText(v: string) {
    if (activeEditing) {
      setEditingTurn((cur) =>
        cur && cur.sess === sess && cur.botId === bot.botId ? { ...cur, text: v } : cur,
      );
      if (sendError) setSendError(null);
      return;
    }
    drafts.editText(v);
    if (sendError) setSendError(null);
    if (lastSendRecordId) setSendNotice(null);
  }

  function addFile(ref: { name: string; path: string; size: number }) {
    if (activeEditing) return;
    drafts.addFile(ref);
  }

  function removeFile(i: number) {
    if (activeEditing) return;
    drafts.removeFile(i);
  }

  function removeAttachment(i: number) {
    if (activeEditing) {
      setEditingTurn((cur) =>
        cur && cur.sess === sess && cur.botId === bot.botId
          ? { ...cur, attachments: cur.attachments.filter((_, idx) => idx !== i) }
          : cur,
      );
      return;
    }
    drafts.removeAttachment(i);
  }

  const attachmentFetcher = useMemo<AttachmentFetcher | null>(() => {
    if (!identity) return null;
    return async (attachmentId) => api.call(identity, 'getAttachment', { botId: bot.botId, attachmentId }) as Promise<ImageAttachmentData>;
  }, [api, identity, bot.botId]);

  async function pickFile() {
    if (!identity || lockedRef.current || isArchived || activeEditing) return;
    try {
      const ref = await api.pickFile();
      if (ref && isCurrentSession() && !lockedRef.current) addFile(ref);
    } catch (e) {
      if (!isCurrentSession()) return;
      setSendError('选择文件失败：' + errText(e));
    }
  }

  const [imageUploadSession, setImageUploadSession] = useState<string | null>(null);
  const imageUploading = imageUploadSession === sess;

  /** 桌面只选图（无原生相机）；上传归属冻结在发起时的 identity/botId/draftKey（或编辑态 entryId）。
   *  addAttachment 的 expectedKey 是原子 guard（useDrafts 内部 keyRef 实时比较）：
   *  切换 Bot/身份后未完成批次中止，已上传结果不写新 scope 草稿。
   *  相同图片 id 去重；去重后总数 ≤4，超限整体拒绝保留原草稿。 */
  function pickImage(input?: File[] | 'clipboard') {
    const pastedFiles = Array.isArray(input) ? input : undefined;
    if (pastedFiles && pastedFiles.length === 0) return;
    if (input === 'clipboard' && !api.pickImages) return;
    const nativeSource: DesktopImagePickSource | null =
      input === 'clipboard' ? 'clipboard' : pastedFiles ? null : api.pickImages ? 'files' : null;
    const errorPrefix = nativeSource === 'clipboard' ? '粘贴图片失败：' : '选择图片失败：';
    const frozenIdentity = identity;
    const frozenEditEntryId = activeEditing?.entryId ?? null;
    const draftKey = drafts.key;
    if (!frozenIdentity || lockedRef.current || isArchived || imageUploading || editSubmitting) return;
    if (frozenEditEntryId === null && !draftKey) return;
    const baseAttachments = activeEditing ? activeEditing.attachments : drafts.attachments;
    setImageUploadSession(sess);
    const release = () => {
      if (mountedRef.current) setImageUploadSession(current => current === sess ? null : current);
    };
    const handleFiles = async (files: File[]) => {
      try {
        const normalized = await Promise.all(files.map((file) => normalizeImageFile(file, file.name)));
        const existing = new Set(baseAttachments.map((a) => a.id));
        const queued: PickedImageSource[] = [];
        for (const source of normalized) {
          const id = await attachmentIdOf(source.data);
          if (existing.has(id)) continue;
          existing.add(id);
          queued.push(source);
        }
        if (!isCurrentSession()) return;
        if (baseAttachments.length + queued.length > IMAGE_MAX_COUNT) {
          setSendError(`最多 ${IMAGE_MAX_COUNT} 张图片，本次未上传。`);
          return;
        }
        const totalBytes = baseAttachments.reduce((sum, a) => sum + a.size, 0)
          + queued.reduce((sum, s) => sum + s.size, 0);
        if (totalBytes > IMAGE_MAX_TOTAL_BYTES) {
          setSendError(`图片总大小超过 ${IMAGE_MAX_TOTAL_BYTES / 1048576}MB，本次未上传。`);
          return;
        }
        for (const source of queued) {
          const att = await api.call(frozenIdentity, 'uploadAttachment', {
            botId: bot.botId,
            name: attachmentFileName(source.name, source.mimeType),
            mimeType: source.mimeType,
            data: source.data,
          });
          if (!isCurrentSession()) return;
          if (frozenEditEntryId !== null) {
            let applied = false;
            setEditingTurn((cur) => {
              if (
                !cur ||
                cur.sess !== sess ||
                cur.botId !== bot.botId ||
                cur.entryId !== frozenEditEntryId ||
                cur.attachments.length >= IMAGE_MAX_COUNT ||
                cur.attachments.some((a) => a.id === att.id)
              ) {
                return cur;
              }
              applied = true;
              return { ...cur, attachments: [...cur.attachments, { ...att }] };
            });
            if (!applied) return;
          } else if (!draftKey || !drafts.addAttachment(att, draftKey)) {
            return;
          }
        }
        setSendError(null);
      } catch (e) {
        if (!isCurrentSession()) return;
        setSendError(errorPrefix + errText(e));
      }
    };
    if (pastedFiles) {
      void handleFiles(pastedFiles).finally(release);
      return;
    }
    if (nativeSource && api.pickImages) {
      const nativePick = api.pickImages;
      void (async () => {
        try {
          const picked = await nativePick(nativeSource);
          if (!isCurrentSession()) return;
          const files = pickedImagesToFiles(picked);
          if (files.length === 0) return;
          await handleFiles(files);
        } catch (e) {
          if (!isCurrentSession()) return;
          setSendError(errorPrefix + errText(e));
        }
      })().finally(release);
      return;
    }
    pickImagesFromInput({
      onPicked: handleFiles,
      onSettled: release,
    });
  }

  const [observedLive, setObservedLive] = useState<{ session: string; state: BotLiveState } | null>(null);
  const rawLive = observedLive && (!online || observedLive.session === sess) ? observedLive.state : null;
  const live = isStaleLiveState(rawLive, clearedThroughEntryId) ? null : rawLive;
  const [liveLast, setLiveLast] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveEnded, setLiveEnded] = useState(false);
  const [watchTick, setWatchTick] = useState(0);
  const [stoppingSession, setStoppingSession] = useState<string | null>(null);
  const [confirmedStopTarget, setConfirmedStopTarget] = useState<string | null>(null);
  const stopButtonRef = useRef<HTMLButtonElement>(null);
  const stopping = stoppingSession === sess;
  const [avatarVersion, setAvatarVersion] = useState(0);

  /**
   * 显式发送 /clear 与 /compact：只走 Host 控制方法（clearHistory/compact），不经模型 submit。
   * 离线/忙碌/归档/发送中由入口 disabled 与这里守卫；成功后清理本地命令草稿并立即重读完整
   * 可见历史；失败保留草稿与旧历史、不自动重放，也绝不降级当普通模型任务发送。
   */
  async function runSlash(command: SlashCommandName) {
    const current = api.identity;
    const draftKey = drafts.key;
    const draftText = drafts.text;
    if (!current || !draftKey || manageInFlightRef.current) return;
    const clearBoardKey = command === '/clear'
      ? botBoardKey(`${current.profileId}|${current.kind}`, current.targetDeviceId, bot.botId)
      : null;
    lockedRef.current = true;
    setSlashBusy(command);
    setSendState('sending');
    setSendError(null);
    setSendNotice({ text: command === '/clear' ? '正在清空对话…' : '正在压缩上下文…' });
    try {
      const result = await api.call(current, command === '/clear' ? 'clearHistory' : 'compact', { botId: bot.botId });
      if (command === '/clear') {
        const clearedId = readClearedThroughEntryId(
          (result as ClearHistoryResult | undefined)?.clearedThroughEntryId,
        ) ?? 0;
        if (!applyConfirmedClear(clearBoardKey!, clearedId)) return;
      }
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      // 服务端已成功后才清命令草稿：沿用 clearDraft CAS，仅当持久草稿仍是该命令文本且无文件/图片
      // 引用时清空；等待期间写入的新文本或附件保留（与手机端 runSlashCommand 同约定）。
      const persisted = api.snapshot?.state.drafts[draftKey];
      if (
        persisted &&
        persisted.text === draftText &&
        persisted.files.length === 0 &&
        !(persisted.attachments?.length)
      ) {
        try {
          await api.clearDraft(draftKey, [{ text: draftText, files: [] }]);
          if (
            isCurrentSession() &&
            drafts.text === draftText &&
            drafts.files.length === 0 &&
            drafts.attachments.length === 0
          ) {
            drafts.editText('');
          }
        } catch {
          // CAS 冲突/写失败：持久草稿保留，不掩盖服务端已成功的事实。
        }
      } else if (
        drafts.text === draftText &&
        drafts.files.length === 0 &&
        drafts.attachments.length === 0
      ) {
        drafts.editText('');
      }
      // 服务端成功后立即重读完整可见历史（busy 下降沿兜底也会补跑）。
      if (!isCurrentSession()) return;
      void loadRawLatest();
      setSendNotice({
        text: command === '/clear'
          ? '已清空当前对话并重置上下文'
          : (result as CompactResult | undefined)?.compacted
            ? '已压缩较早的上下文'
            : '没有可压缩的历史',
      });
      window.setTimeout(() => {
        if (isCurrentSession()) setSendNotice(null);
      }, 2500);
    } catch (e) {
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      setSendNotice(null);
      if (command === '/clear') {
        const { message, isUnknown } = describeClearError('/clear', e, api.transportConnected, tErr);
        setSendError(message);
        if (isUnknown && api.transportConnected) void loadRawLatest();
        reportUnlessTargetOffline(api, e);
      } else {
        setSendError(command + ' 失败：' + tErr(e) + '；草稿与历史保留，不会当普通消息发送。');
        reportUnlessTargetOffline(api, e);
      }
    } finally {
      lockedRef.current = false;
      if (mountedRef.current) {
        setSlashBusy(null);
        setSendState('idle');
      }
    }
  }

  const [outboxPendingItems, setOutboxPendingItems] = useState<PendingRecord[]>([]);
  const [queueBusy, setQueueBusy] = useState(false);

  const refreshOutboxPending = useCallback(async () => {
    const current = api.identity;
    if (!current) {
      if (mountedRef.current) setOutboxPendingItems([]);
      return;
    }
    try {
      const matched: PendingRecord[] = [];
      let cursor: PendingCursor | null = null;
      for (let pageNo = 0; pageNo < 10; pageNo += 1) {
        const page: PendingListPage = await api.pending(current, 'pending_list', { options: { limit: 50, cursor } });
        for (const item of page.items) {
          if (
            item.kind === 'primary' &&
            item.botId === bot.botId &&
            item.targetDeviceId === current.targetDeviceId &&
            item.state === 'pending'
          ) {
            matched.push(item);
          }
        }
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      if (mountedRef.current && sessionKey(api.identity) === sessionKey(current)) {
        setOutboxPendingItems(matched);
      }
    } catch {
      // 本地 outbox 读取失败不阻塞主视图
    }
  }, [api, bot.botId]);

  useEffect(() => {
    if (!pageActive) return;
    void refreshOutboxPending();
    if (outboxPendingItems.length === 0) return;
    const timer = window.setInterval(() => {
      void refreshOutboxPending();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pageActive, sess, bot.botId, outboxPendingItems.length, refreshOutboxPending]);

  async function submitEditedTurn() {
    if (!identity || !online || !activeEditing || editSubmitting || lockedRef.current || isArchived) return;
    if (imageUploading) return;
    const curActivity = resolveBotActivity(live);
    const curTurnAdmission = live !== null ? readTurnAdmission(live.turnAdmission) : turnAdmission;
    if (
      stopping ||
      Boolean(live?.busy) ||
      (live?.queuedCount ?? 0) > 0 ||
      isBotActivityBusy(curActivity) ||
      (curTurnAdmission !== null && curTurnAdmission.phase !== 'failed')
    ) {
      setSendError('Bot 忙碌时无法编辑历史消息，草稿已保留，请稍后重试或按 Esc 取消。');
      return;
    }
    const msg = activeEditing.text.trim();
    const attachmentIds = activeEditing.attachments.map((a) => a.id);
    if (!msg && attachmentIds.length === 0) return;
    const targetEntryId = activeEditing.entryId;
    const requestId = crypto.randomUUID();
    lockedRef.current = true;
    setEditSubmitting(true);
    setSendState('sending');
    setSendError(null);
    setSendNotice(null);
    try {
      const receipt = (await api.call(identity, 'editMessage', {
        botId: bot.botId,
        requestId,
        entryId: targetEntryId,
        text: msg,
        ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
      })) as PrimarySubmission;
      if (!isCurrentSession()) return;
      setEditingTurn(null);
      const nextAdmission = readTurnAdmission((receipt as { admission?: unknown }).admission);
      if (nextAdmission) {
        lastEditedAdmissionRef.current = {
          sess,
          botId: bot.botId,
          requestId,
          text: msg,
          attachments: attachmentIds,
        };
      }
      setTurnAdmission(nextAdmission);
      void loadRawLatest();
      onLiveActivityRef.current?.();
    } catch (e) {
      if (!isCurrentSession()) return;
      if (toError(e).code === 'RUNTIME_BUSY') {
        setSendError('Bot 忙碌时无法编辑历史消息，草稿已保留，请稍后重试或按 Esc 取消。');
      } else {
        setSendError('编辑重发失败：' + tErr(e));
        reportUnlessTargetOffline(api, e);
      }
    } finally {
      lockedRef.current = false;
      if (mountedRef.current) {
        setEditSubmitting(false);
        setSendState('idle');
      }
    }
  }

  async function handleSend(delivery: TurnDeliveryMode = 'followUp') {
    if (activeEditing) {
      await submitEditedTurn();
      return;
    }
    if (!identity || sendState !== 'idle' || lockedRef.current || isArchived) return;
    if (imageUploading) return;
    if (online) {
      const curActivity = resolveBotActivity(live);
      const curTurnAdmission = live !== null ? readTurnAdmission(live.turnAdmission) : turnAdmission;
      if (
        stopping ||
        curActivity.phase === 'stopping' ||
        (!isBotLlmRunningPhase(curActivity.phase) &&
          (isBotPreLlmPhase(curActivity.phase) ||
            (live === null && curTurnAdmission !== null && curTurnAdmission.phase !== 'failed')))
      ) {
        return;
      }
    }
    const msg = drafts.text.trim();
    const attachmentIds = drafts.attachments.map((a) => a.id);
    if (!msg && attachmentIds.length === 0) return;
    setLastSendRecordId(undefined);
    setSendNotice(null);
    const command = parseSlashCommand(msg);
    if (command && attachmentIds.length === 0) {
      if (
        live?.busy ||
        (command === '/clear' && (isBotActivityBusy(resolveBotActivity(live)) || (live?.queuedCount ?? 0) > 0 || stopping)) ||
        drafts.attempt ||
        drafts.savePaused ||
        drafts.files.length > 0
      ) {
        setSendError('请等待当前任务结束、处理未确认的发送，并移除路径引用后再执行命令。');
        return;
      }
      if (!online) {
        setSendError('离线：' + command + ' 未执行，草稿保留，连接后请重试。');
        return;
      }
      void runSlash(command);
      return;
    }
    const filesNow = drafts.files;
    const linkedTaskSnapshot = linkedTask;
    const capturedTaskScopeKey = taskScopeKey;
    const capturedBotSnapshot = { deviceId: bot.deviceId, botId: bot.botId, role: bot.role };
    const taskPrefix = resolvedTaskContext.taskPrefix;
    const bodyText = taskPrefix ? (msg ? `${taskPrefix}${msg}` : taskPrefix.trimEnd()) : msg;
    const composed = filesNow.length
      ? (bodyText ? `${bodyText}\n` : '') + filesNow.map((f) => `[文件路径引用，未上传] ${f.path}`).join('\n')
      : bodyText;
    const requestId = crypto.randomUUID();
    const input: PendingEnqueueInput = {
      kind: 'primary',
      targetDeviceId: identity.targetDeviceId,
      botId: bot.botId,
      requestId,
      text: composed,
      ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
      ...(delivery === 'steer' ? { delivery: 'steer' } : {}),
    };
    const started = drafts.beginSend(input);
    if (!started) return;
    lockedRef.current = true;
    setSendState('sending');
    setSendError(null);
    setRecOutcome(null);
    // 只发送冻结副本：await 后不重组身份/业务 ID。
    const frozen = started.attempt.input;
    try {
      await drafts.waitQuiet(started.handle);
      let rec: PendingRecord | null = null;
      try {
        rec = await api.pending(identity, 'pending_enqueue', { input: frozen });
      } catch (e) {
        // 只有本阶段明确 not-sent（无队列记录）才可声称未入队。
        if (isNotSent(e)) {
          const errMsg = '消息尚未发出。恢复编辑后可以重新发送。';
          drafts.markNotSent(started.handle, errMsg);
          setSendError(errMsg);
        } else {
          drafts.markUnconfirmed(started.handle);
          setSendError(null);
        }
        return;
      }
      if (!rec) return;
      drafts.setPending(started.handle, rec.id);
      const pendingId = rec.id;
      setLastSendRecordId(pendingId);
      const cleared = await drafts.confirmCleared(started.handle);
      if (cleared !== 'cleared') {
        const errMsg = cleared === 'conflict'
          ? '消息已加入发送记录。请先处理更新后的草稿。'
          : '消息已加入发送记录，可以在那里继续处理。';
        drafts.markFailed(started.handle, errMsg);
        setSendError(errMsg);
        return;
      }
      if (!api.transportConnected || sessionKey(api.identity) !== sess) {
        drafts.finishSend(started.handle);
        setSendNotice({
          text: '消息已加入发送记录。连接恢复后，可以从记录里发送。',
          showRecordAction: true,
        });
        return;
      }
      try {
        const sent = await api.pending(identity, 'pending_send', { id: pendingId });
        reportSendRecord(started.handle, sent);
        if (sent.state === 'accepted' && linkedTaskSnapshot && msg) {
          if (
            linkedTaskSnapshot.pendingPrompt?.kind === 'question' &&
            isTaskWaitingForBot(linkedTaskSnapshot, capturedBotSnapshot.deviceId, capturedBotSnapshot.botId)
          ) {
            void onRunTaskAction?.({
              kind: 'answer_prompt',
              scopeKey: capturedTaskScopeKey,
              botKey: `${capturedBotSnapshot.deviceId}:${capturedBotSnapshot.botId}`,
              taskId: linkedTaskSnapshot.id,
              taskTitle: linkedTaskSnapshot.title,
              answer: msg,
            });
          } else if (
            linkedTaskSnapshot.pendingPrompt?.kind === 'plan' &&
            isTaskWaitingForBot(linkedTaskSnapshot, capturedBotSnapshot.deviceId, capturedBotSnapshot.botId)
          ) {
            void onRunTaskAction?.({
              kind: 'update_task',
              scopeKey: capturedTaskScopeKey,
              botKey: `${capturedBotSnapshot.deviceId}:${capturedBotSnapshot.botId}`,
              taskId: linkedTaskSnapshot.id,
              taskTitle: linkedTaskSnapshot.title,
              payload: {
                taskId: linkedTaskSnapshot.id,
                fromChatBotId: capturedBotSnapshot.botId,
                fromChatDeviceId: capturedBotSnapshot.deviceId,
                logText: `${capturedBotSnapshot.role} 对话补充：${msg.slice(0, 120)}`,
              },
            });
          }
        }
      } catch (e) {
        // 回执丢失/超时/未知：已入队，保留原 ID 锁，绝不标未入队。
        drafts.markUnconfirmed(started.handle);
        setSendError(null);
      }
    } finally {
      lockedRef.current = false;
      setSendState('idle');
      void refreshOutboxPending();
    }
  }

  function reportSendRecord(handle: { key: string; attemptId: string }, rec: PendingRecord) {
    const hostQueued = readHostQueuedReceipt(rec);
    // Host-queued：本地已持久化并等待中心准入，submissionId 为 null 属正常，不视为缺失。
    setTurnAdmission(hostQueued ? hostQueued.admission : null);
    if (rec.state === 'accepted') {
      drafts.finishSend(handle);
      // 受理只说明已受理；前置准入与运行阶段统一由右下角按钮与 live 状态呈现，不在输入框下方写状态字。
      setSendNotice(null);
      onLiveActivityRef.current?.();
    } else if (rec.state === 'rejected') {
      // 确定终态：本地 attempt 结束，原记录保留在待发送面板
      drafts.finishSend(handle);
      setSendError(
        rec.lastError?.code === 'MODEL_NO_VISION'
          ? 'MODEL_NO_VISION: model does not accept image input'
          : '设备未接收消息。详情见发送记录。',
      );
    } else if (rec.state === 'unconfirmed' || rec.state === 'sending') {
      drafts.markUnconfirmed(handle);
      setSendError(null);
    } else {
      drafts.finishSend(handle);
      setSendNotice({
        text: '消息待发送，可在记录里继续发送。',
        showRecordAction: true,
      });
    }
  }

  async function queryPending(silent = false, current = () => true) {
    if (!identity || !drafts.attempt || !drafts.key || lockedRef.current) return;
    const handle = { key: drafts.key, attemptId: drafts.attempt.id };
    lockedRef.current = true;
    const outcome = await drafts.reconcile(handle, { silent }).finally(() => { lockedRef.current = false; });
    if (!isCurrentSession() || !current()) return;
    setRecOutcome(outcome);
    if (outcome.recordId) setLastSendRecordId(outcome.recordId);
    if (outcome.action === 'finished' && outcome.recordState === 'accepted') {
      setSendError(null);
      setSendNotice(null);
    } else if (outcome.action === 'finished') {
      setSendError('设备未接收消息。详情见发送记录。');
    } else if (outcome.action === 'ready-clear-retry') {
      setSendError('已找到发送记录，可以重试清空本地草稿。');
    } else if (outcome.found) {
      setSendError(drafts.conflict ? '草稿已更新，请保留需要的内容。' : null);
    } else {
      if (!silent) setSendError(null);
    }
  }

  useReceiptRecovery(`${sess}|${bot.botId}|${drafts.attempt?.id ?? ''}`, Boolean(drafts.attempt &&
    drafts.attempt.phase !== 'not-sent' && sendState === 'idle' && !drafts.conflict), online && pageActive,
    current => queryPending(true, current));

  async function retryClearVerified() {
    if (!identity || !drafts.attempt || !drafts.key) return;
    const handle = { key: drafts.key, attemptId: drafts.attempt.id };
    const r = await drafts.retryClearAfterVerify(handle);
    if (r === 'cleared') {
      setRecOutcome(null);
      setSendError('本地草稿已清空，原记录保留在待发送面板，由面板显式发送。');
    } else if (r === 'conflict') {
      setSendError('草稿尚未清空：磁盘草稿已被更新；请查看新版草稿并选择“保留新版草稿，结束旧尝试”。');
    } else {
      setSendError('重试本地清空失败，仍保持锁。');
    }
  }

  function adoptNewerDraft() {
    if (!drafts.attempt || !drafts.key) return;
    const handle = { key: drafts.key, attemptId: drafts.attempt.id };
    const r = drafts.adoptNewerDraftAndFinish(handle);
    if (r.ok) {
      setRecOutcome(null);
      setSendError('已保留新版草稿并结束旧尝试；原队列记录仍在待发送面板，未清磁盘也未发送。');
    } else {
      setSendError(r.error ?? '无法采用新版草稿');
    }
  }

  async function adoptPersistedDraft() {
    if (!drafts.key || drafts.attempt) return;
    const r = await drafts.adoptPersistedDraft(drafts.key);
    if (!isCurrentSession()) return;
    if (r.ok) {
      setSendError(null);
    } else if (r.error) {
      setSendError(r.error);
    }
  }

  /** 找到本 Bot 最近一条 Host-queued 记录（优先匹配指定 requestId；返回 null 表示无等待项）。 */
  async function findHostAdmissionRecord(preferredRequestId?: string): Promise<PendingRecord | null> {
    const current = api.identity;
    if (!current) return null;
    let cursor: PendingCursor | null = null;
    let fallback: PendingRecord | null = null;
    for (let pageNo = 0; pageNo < 20; pageNo += 1) {
      const page: PendingListPage = await api.pending(current, 'pending_list', { options: { limit: 50, cursor } });
      if (preferredRequestId) {
        const exact = page.items.find(
          (item: PendingRecord) => item.kind === 'primary' && item.botId === bot.botId && item.requestId === preferredRequestId,
        );
        if (exact) return exact;
      }
      if (!fallback) {
        fallback = page.items.find(
          (item: PendingRecord) => item.kind === 'primary' && item.botId === bot.botId && readHostQueuedReceipt(item) !== null,
        ) ?? null;
        if (fallback && !preferredRequestId) return fallback;
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return fallback;
  }

  /** 显式刷新 Host 准入状态；找不到等待记录即清空显示。 */
  async function refreshTurnAdmission() {
    try {
      const rec = await findHostAdmissionRecord(turnAdmission?.requestId);
      if (isCurrentSession()) setTurnAdmission(rec ? readHostQueuedReceipt(rec)?.admission ?? null : null);
    } catch (e) {
      if (isCurrentSession()) reportUnlessTargetOffline(api, e);
    }
  }

  /**
   * Host 准入失败后的显式重试：用持久化记录里冻结的原 requestId/原文本直接调远端 submit。
   * 不能走 pending_send：已 accepted 的本地 outbox 记录会被 store 短路，永远达不到 Host。
   * Host 端按 requestId+摘要幂等受理同一队列条目，绝不产生第二条消息；返回回执直接刷新准入状态。
   */
  async function retryTurnAdmission() {
    const current = api.identity;
    if (!current || !api.transportConnected || sendState !== 'idle' || lockedRef.current || isArchived) return;
    lockedRef.current = true;
    setSendState('sending');
    setSendError(null);
    try {
      const failedRequestId = effectiveTurnAdmission?.phase === 'failed' ? effectiveTurnAdmission.requestId : undefined;
      const rec = await findHostAdmissionRecord(failedRequestId);
      if (!isCurrentSession()) return;
      const recAdmission = rec ? readHostQueuedReceipt(rec)?.admission ?? null : null;
      const editedFallback =
        !rec &&
        failedRequestId &&
        lastEditedAdmissionRef.current?.sess === sess &&
        lastEditedAdmissionRef.current.botId === bot.botId &&
        lastEditedAdmissionRef.current.requestId === failedRequestId
          ? lastEditedAdmissionRef.current
          : null;
      const isFailed =
        Boolean(
          effectiveTurnAdmission?.phase === 'failed' &&
            (!failedRequestId || (rec?.kind === 'primary' ? rec.requestId : editedFallback?.requestId) === failedRequestId),
        ) || recAdmission?.phase === 'failed';
      if ((!rec && !editedFallback) || !isFailed) {
        if (mountedRef.current && rec) setTurnAdmission(recAdmission);
        return;
      }
      const submitParams = rec && rec.kind === 'primary'
        ? {
            botId: rec.botId,
            requestId: rec.requestId,
            text: rec.text,
            ...(rec.attachments?.length ? { attachments: rec.attachments } : {}),
            ...(rec.delivery ? { delivery: rec.delivery } : {}),
          }
        : {
            botId: editedFallback!.botId,
            requestId: editedFallback!.requestId,
            text: editedFallback!.text,
            ...(editedFallback!.attachments.length ? { attachments: editedFallback!.attachments } : {}),
          };
      const receipt = await api.call(current, 'submit', submitParams);
      if (!isCurrentSession()) return;
      const nextAdmission = readTurnAdmission((receipt as { admission?: unknown }).admission);
      setTurnAdmission(nextAdmission);
      if (rec) {
        // 本地 outbox 记录 receipt 仍带旧 admission：显式对账刷新一次（只读，不改远端状态）。
        try { await api.pending(current, 'pending_reconcile', { id: rec.id }); } catch { /* 对账失败不掩盖重试结果 */ }
      }
    } catch (e) {
      if (!isCurrentSession()) return;
      reportUnlessTargetOffline(api, e);
      setSendError('重试结果尚未确认：' + tErr(e) + '。原消息记录已保留，可稍后再次重试，不会重复发送。');
    } finally {
      lockedRef.current = false;
      if (mountedRef.current) setSendState('idle');
    }
  }

  /** 将准入失败的消息从 Host 队列撤回并安全合并回输入框（不覆盖用户刚写的新草稿）。 */
  async function restoreFailedTurnAdmission() {
    const current = api.identity;
    const targetRequestId = effectiveTurnAdmission?.phase === 'failed' ? effectiveTurnAdmission.requestId : undefined;
    if (!current || !api.transportConnected || !targetRequestId || queueBusy || sendState !== 'idle' || lockedRef.current || isArchived) {
      return;
    }
    if (drafts.attempt) {
      setSendError('当前存在未确认的发送草稿，请先处理后再恢复失败消息。');
      return;
    }
    const frozenDraftKey = drafts.key ?? undefined;
    setQueueBusy(true);
    setSendError(null);
    try {
      const res = (await api.call(current, 'withdrawQueued', {
        botId: bot.botId,
        requestId: targetRequestId,
      })) as WithdrawQueuedResult;
      if (!isCurrentSession()) return;
      const withdrawn = Array.isArray(res?.withdrawn) ? res.withdrawn : [];
      if (withdrawn.length > 0) {
        const texts = withdrawn
          .map((w) => (w.attachments?.length ? stripTrailingHostAttachmentLines(w.text, w.attachments.length) : w.text))
          .filter((s) => typeof s === 'string' && s.trim().length > 0);
        const attIds = withdrawn.flatMap((w) => (Array.isArray(w.attachments) ? w.attachments : []));
        const resolvedAtts = await resolveAttachmentMetasByIds(attIds, attachmentFetcher);
        if (!isCurrentSession()) return;
        drafts.mergeRecalled(texts, resolvedAtts, frozenDraftKey);
        setTurnAdmission((cur) => (cur?.requestId === targetRequestId ? null : cur));
        if (lastEditedAdmissionRef.current?.requestId === targetRequestId) {
          lastEditedAdmissionRef.current = null;
        }
        window.setTimeout(() => composerRef.current?.focus(), 0);
      } else {
        await refreshTurnAdmission();
      }
      onLiveActivityRef.current?.();
    } catch (e) {
      if (!isCurrentSession()) return;
      setSendError('恢复编辑失败：' + tErr(e));
      reportUnlessTargetOffline(api, e);
    } finally {
      if (mountedRef.current) setQueueBusy(false);
    }
  }

  function releaseNotSent() {
    if (!drafts.attempt || !drafts.key) return;
    const handle = { key: drafts.key, attemptId: drafts.attempt.id };
    const r = drafts.releaseIfNotSent(handle);
    if (r.ok) {
      setRecOutcome(null);
      setSendError('已恢复编辑（确认未入队）。');
    } else {
      setSendError(r.error ?? '无法释放');
    }
  }

  const [rawItems, setRawItems] = useState<AnyRawEntry[]>([]);
  const boardTarget: BotBoardTarget | undefined = identity ? {
    key: botBoardKey(`${identity.profileId}|${identity.kind}`, identity.targetDeviceId, bot.botId),
    hostKey: identity.targetDeviceId,
    generation: sess,
    botId: bot.botId,
    name: bot.role,
    deviceName,
    avatarKey: botAvatarKey(bot),
    online,
    read: botIds => api.call(identity, 'getBotBoard', { botIds }),
  } : undefined;
  const chatBoard = useBotBoard(boardTarget ? [boardTarget] : [], pageActive);
  const transcriptActive = pageActive && transcriptVisible && online && chatBoard.visible &&
    !inspectorTab && !liveEnded && !liveError;
  const boardRecord = boardTarget ? chatBoard.records.get(boardTarget.key) : undefined;
  const resultId = boardRecord?.item?.conversationId === bot.primaryConversationId
    ? boardRecord.item.lastResult?.id
    : undefined;
  const boardResultId = transcriptActive && boardTarget && boardRecord?.generation === sess &&
    !boardRecord.error && chatBoard.seen.get(boardTarget.key) !== resultId ? resultId : undefined;
  const markViewedBoardResult = useMarkViewedBoardResult(chatBoard, boardTarget, transcriptActive);
  const onViewedResult = useCallback((id: string) => {
    if (api.transportConnected && sessionKey(api.identity) === sess) markViewedBoardResult([id]);
  }, [api, sess, markViewedBoardResult]);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const rawCursorRef = useRef<Record<string, unknown> | null>(null);
  /**
   * 每轮任务完结（busy true→false）或观察结束时，沿升序游标逐页读完整可见历史
   * （与手机端 Host.tsx fetchBotHistoryPages 一致：首帧=最早页，继续翻页到尽头才包含最新条目），
   * 成功后整体替换本地可见历史——/clear 之后服务端已按 reset 裁剪，旧条目随之消失。
   * 单飞：busy 期间 token 级 update 不触发；turns 之间间隔靠飞行中标记+补跑标志合并。
   * 失败保留旧数据并置可见错误（聊天流顶部重试条），不静默丢弃。
   */
  // 重连后的读取属于新代次，旧请求既不能覆盖它，也不能吞掉这次刷新。
  const latestFlightRef = useRef<{ session: string; dirty: boolean } | null>(null);
  const prevBusyRef = useRef(false);

  const applyCutoff = useCallback((candidate: number, invalidateFlight = true): boolean => {
    const normalized = readClearedThroughEntryId(candidate) ?? 0;
    if (normalized <= cutoffRef.current) return false;
    cutoffRef.current = normalized;
    setClearedThroughEntryId(normalized);
    onClearedThroughEntryIdRef.current?.(normalized);
    setRawItems((prev) => {
      const filtered = prev.filter((item) => numericRawEntryId(item) > normalized);
      return filtered.length === prev.length ? prev : filtered;
    });
    setEditingTurn((cur) => (cur && cur.entryId <= normalized ? null : cur));
    setTurnAdmission(null);
    if (invalidateFlight && latestFlightRef.current) latestFlightRef.current.dirty = true;
    return true;
  }, []);

  const loadRawLatest = useCallback(async () => {
    if (!identity || !api.transportConnected || !isCurrentSession()) return;
    if (latestFlightRef.current?.session === sess) {
      latestFlightRef.current.dirty = true;
      return;
    }
    const flight = { session: sess, dirty: false };
    latestFlightRef.current = flight;
    try {
      const all: AnyRawEntry[] = [];
      let cursor: Record<string, unknown> | null = null;
      const startCutoff = cutoffRef.current;
      let hasEpoch = false;
      let passEpoch: number | undefined;
      try {
        for (;;) {
          const page: Awaited<ReturnType<typeof readHistoryPage<AnyRawEntry>>> = await readHistoryPage<AnyRawEntry>(async (c, limit, chunked) => {
            if (!isCurrentSession()) return null;
            return api.call(identity, 'history', { botId: bot.botId, limit, cursor: c, ...(chunked ? { chunked: true } : {}) });
          }, cursor, 200);
          if (!page || !isCurrentSession()) return;

          const pageCleared = readClearedThroughEntryId(
            (page as { clearedThroughEntryId?: unknown }).clearedThroughEntryId,
          );
          if (!hasEpoch) {
            hasEpoch = true;
            passEpoch = pageCleared;
          } else if (pageCleared !== passEpoch) {
            if (pageCleared !== undefined) applyCutoff(pageCleared, false);
            flight.dirty = true;
            return;
          }
          if (pageCleared !== undefined) applyCutoff(pageCleared, false);

          const items = page.items;
          const resetInItems = latestResetEntryIdFromItems(items);
          if (resetInItems > cutoffRef.current) {
            applyCutoff(resetInItems, false);
            flight.dirty = true;
            return;
          }
          if (cutoffRef.current > Math.max(startCutoff, passEpoch ?? 0)) {
            flight.dirty = true;
            return;
          }

          if (items.length === 0) break;
          all.push(...items);
          if (!page.nextCursor || typeof page.nextCursor !== 'object' || Array.isArray(page.nextCursor)) break;
          cursor = page.nextCursor;
        }
      } catch (pageErr) {
        if (
          pageErr instanceof HistoryEpochChangedError ||
          (cursor !== null && toError(pageErr).code === 'INVALID_ARGUMENT' && cutoffRef.current > Math.max(startCutoff, passEpoch ?? 0))
        ) {
          flight.dirty = true;
          return;
        }
        throw pageErr;
      }

      if (!isCurrentSession()) return;
      const effectiveCutoff = cutoffRef.current;
      if (effectiveCutoff > Math.max(startCutoff, passEpoch ?? 0)) {
        flight.dirty = true;
        return;
      }
      // 完整可见历史整体替换：/clear 后 reset 之前的条目不再回归，不再依赖截断的 live 窗口。
      setRawItems(effectiveCutoff > 0 ? all.filter((item) => numericRawEntryId(item) > effectiveCutoff) : all);
      rawCursorRef.current = null;
      setRawError(null);
    } catch (e) {
      // 失败保留旧数据：重试按钮在聊天流顶部可见，下一次完结/重连也会再补跑。
      if (isCurrentSession()) {
        if (toError(e).code === 'BOT_NOT_FOUND') {
          readScope.suspend();
          onBotDeletedRef.current(bot.botId);
          return;
        }
        setRawError(tErr(e));
      }
    } finally {
      if (latestFlightRef.current === flight) {
        latestFlightRef.current = null;
        if (flight.dirty && isCurrentSession()) void loadRawLatest();
      }
    }
  }, [api, applyCutoff, bot.botId, identity, isCurrentSession, sess]);

  /**
   * 历史只读路径只有一条：无论首次进入、重连、重试或 busy 下降沿，都复用 loadRawLatest
   * 的完整分页单飞读取；这里只保留 loading 标记，失败错误由 loadRawLatest 自身置位。
   */
  const loadRaw = useCallback(async () => {
    if (!identity || !api.transportConnected || !isCurrentSession()) return;
    setRawLoading(true);
    try {
      await loadRawLatest();
    } finally {
      if (isCurrentSession()) setRawLoading(false);
    }
  }, [api, identity, isCurrentSession, loadRawLatest]);

  // busy true→false 下降沿触发合并刷新；live.busy 首帧为 true 也等下一轮完结。
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    const busy = Boolean(live?.busy);
    prevBusyRef.current = busy;
    if (wasBusy && !busy) void loadRawLatest();
  }, [live?.busy, loadRawLatest]);

  useEffect(() => {
    // 离线/页面不可见（远端页切回本机）不发 observe：保留最后读取的 live 数据，重连后被动重建。
    if (!identity || !api.transportConnected || !pageActive || !isCurrentSession()) return;
    const localSess = sess;
    let disposed = false;
    let handle: { close(): Promise<void> } | null = null;
    void (async () => {
      if (disposed) return;
      setObservedLive(null);
      setLiveError(null);
      setLiveEnded(false);
      setLiveLast(null);
      try {
        const h = api.observe(identity, { kind: 'primary', botId: bot.botId }, (ev) => {
          if (disposed || !isCurrentSession()) return;
          if (sessionKey(api.identity) !== localSess) return;
          if ('error' in ev) {
            const err = ev as Extract<DesktopObservationEvent, { error: unknown }>;
            if (toError(err.error).code === 'BOT_NOT_FOUND') {
              readScope.suspend();
              onBotDeletedRef.current(bot.botId);
              return;
            }
            setLiveError(tErr(err.error));
            setLiveEnded(true);
            return;
          }
          const f = ev.frame;
          if (f.type === 'end') {
            setLiveEnded(true);
            setLiveLast(new Date().toISOString());
            // 观察订阅结束兜底重读最新页；常规轮次完结由 busy 下降沿触发（见下）。
            void loadRawLatest();
            onLiveActivityRef.current?.();
            return;
          }
          if ('scopeId' in f) return;
          setLiveLast(new Date().toISOString());
          if (f.type === 'snapshot') {
            const resetFromLive = latestResetEntryIdFromItems(f.state.history);
            const advanced = resetFromLive > cutoffRef.current ? applyCutoff(resetFromLive) : false;
            setObservedLive({ session: localSess, state: f.state });
            // 快照帧可能带整字段 turnAdmission；缺省/形状非法一律清空显示。
            setTurnAdmission(readTurnAdmission((f.state as { turnAdmission?: unknown }).turnAdmission));
            if (advanced) void loadRawLatest();
            onLiveActivityRef.current?.();
          } else {
            const changes = (f as { changes?: Partial<BotLiveState> }).changes;
            if (changes) {
              const resetFromChanges = 'history' in changes ? latestResetEntryIdFromItems(changes.history) : 0;
              const advanced = resetFromChanges > cutoffRef.current ? applyCutoff(resetFromChanges) : false;
              if ('turnAdmission' in changes) {
                setTurnAdmission(readTurnAdmission((changes as { turnAdmission?: unknown }).turnAdmission));
              }
              setObservedLive(prev => prev?.session === localSess
                ? { session: localSess, state: { ...prev.state, ...changes } }
                : prev);
              if (advanced) void loadRawLatest();
              if (advanced || 'history' in changes || 'busy' in changes || 'generation' in changes) {
                onLiveActivityRef.current?.();
              }
            }
          }
        });
        h.ready.catch((e) => {
          if (!disposed && isCurrentSession()) {
            if (toError(e).code === 'BOT_NOT_FOUND') {
              readScope.suspend();
              onBotDeletedRef.current(bot.botId);
              return;
            }
            setLiveError('观察建立失败：' + tErr(e));
            setLiveEnded(true);
          }
        });
        handle = h;
      } catch (e) {
        if (!disposed && isCurrentSession()) {
          setLiveError(tErr(e));
          setLiveEnded(true);
        }
      }
    })();
    return () => {
      disposed = true;
      if (handle) void handle.close().catch(() => {});
    };
  }, [api, applyCutoff, sess, bot.botId, watchTick, online, pageActive, loadRawLatest, isCurrentSession]);

  async function stopTask() {
    if (!identity || stopping || !api.transportConnected) return;
    const frozenDraftKey = drafts.key ?? undefined;
    setStoppingSession(sess);
    try {
      const localTexts: string[] = [];
      const localAttIds: string[] = [];
      try {
        let cursor: PendingCursor | null = null;
        const localPending: Extract<PendingRecord, { kind: 'primary' }>[] = [];
        for (let pageNo = 0; pageNo < 10; pageNo += 1) {
          const page: PendingListPage = await api.pending(identity, 'pending_list', { options: { limit: 50, cursor } });
          for (const item of page.items) {
            if (
              item.kind === 'primary' &&
              item.botId === bot.botId &&
              item.targetDeviceId === identity.targetDeviceId &&
              item.state === 'pending'
            ) {
              localPending.push(item);
            }
          }
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        for (const item of localPending) {
          try {
            await api.pending(identity, 'pending_cancel', { id: item.id });
            if (item.text.trim()) localTexts.push(item.text);
            if (item.attachments?.length) localAttIds.push(...item.attachments);
          } catch {
            // 若刚进入 sending/accepted 则交由下方 Host abort 撤回
          }
        }
      } catch {
        // 本地列表异常不阻断远端 abort
      }
      const res = (await api.call(identity, 'abort', { botId: bot.botId })) as AbortBotResult;
      if (!isCurrentSession()) return;
      const hostWithdrawn: WithdrawnTurnItem[] = Array.isArray(res?.withdrawn) ? res.withdrawn : [];
      const hostTexts = hostWithdrawn
        .map((w) => w.text)
        .filter((s) => typeof s === 'string' && s.trim().length > 0);
      const hostAttIds = hostWithdrawn.flatMap((w) =>
        Array.isArray(w.attachments) ? w.attachments : [],
      );
      const allTexts = [...hostTexts, ...localTexts];
      const allAttIds = [...hostAttIds, ...localAttIds];
      if (allTexts.length > 0 || allAttIds.length > 0) {
        const resolvedAtts = await resolveAttachmentMetasByIds(allAttIds, attachmentFetcher);
        if (!isCurrentSession()) return;
        if (drafts.mergeRecalled(allTexts, resolvedAtts, frozenDraftKey)) {
          window.setTimeout(() => composerRef.current?.focus(), 0);
        }
      }
      void refreshOutboxPending();
    } catch (e) {
      if (!isCurrentSession()) return;
      setLiveError('停止失败：' + tErr(e));
      reportUnlessTargetOffline(api, e);
    } finally {
      if (mountedRef.current) setStoppingSession(current => current === sess ? null : current);
    }
  }

  async function recallQueuedItem(item: UnifiedQueuedStripItem, mergeIntoDraft: boolean) {
    if (!identity || queueBusy || !readsActive || isArchived) return;
    if (mergeIntoDraft && drafts.attempt) {
      setSendError('当前存在未确认的发送草稿，请先处理后再撤回排队消息。');
      return;
    }
    if (disabled) return;
    if (item.source === 'host' && !online) {
      setSendError('目标离线，无法操作远端排队消息。');
      return;
    }
    const frozenDraftKey = drafts.key ?? undefined;
    setQueueBusy(true);
    try {
      if (item.source === 'outbox' && item.outboxRecord) {
        await api.pending(identity, 'pending_cancel', { id: item.outboxRecord.id });
        if (!isCurrentSession()) return;
        if (mergeIntoDraft) {
          const texts = item.outboxRecord.text.trim() ? [item.outboxRecord.text] : [];
          const resolvedAtts = await resolveAttachmentMetasByIds(item.outboxRecord.attachments, attachmentFetcher);
          if (!isCurrentSession()) return;
          if (drafts.mergeRecalled(texts, resolvedAtts, frozenDraftKey)) {
            window.setTimeout(() => composerRef.current?.focus(), 0);
          }
        }
        void refreshOutboxPending();
        return;
      }
      const res = (await api.call(identity, 'withdrawQueued', {
        botId: bot.botId,
        requestId: item.requestId,
      })) as WithdrawQueuedResult;
      if (!isCurrentSession()) return;
      if (mergeIntoDraft && Array.isArray(res?.withdrawn) && res.withdrawn.length > 0) {
        const texts = res.withdrawn
          .map((w) => w.text)
          .filter((s) => typeof s === 'string' && s.trim().length > 0);
        const attIds = res.withdrawn.flatMap((w) => (Array.isArray(w.attachments) ? w.attachments : []));
        const resolvedAtts = await resolveAttachmentMetasByIds(attIds, attachmentFetcher);
        if (!isCurrentSession()) return;
        if (drafts.mergeRecalled(texts, resolvedAtts, frozenDraftKey)) {
          window.setTimeout(() => composerRef.current?.focus(), 0);
        }
      }
    } catch (e) {
      if (!isCurrentSession()) return;
      setSendError((mergeIntoDraft ? '撤回排队消息失败：' : '移除排队消息失败：') + tErr(e));
      reportUnlessTargetOffline(api, e);
    } finally {
      if (mountedRef.current) setQueueBusy(false);
    }
  }

  async function recallAllQueued() {
    if (!identity || queueBusy || !readsActive || isArchived) return;
    if (drafts.attempt) {
      setSendError('当前存在未确认的发送草稿，请先处理后再撤回排队消息。');
      return;
    }
    if (disabled) return;
    const frozenDraftKey = drafts.key ?? undefined;
    setQueueBusy(true);
    try {
      const localTexts: string[] = [];
      const localAttIds: string[] = [];
      for (const rec of outboxPendingItems) {
        if (rec.kind !== 'primary' || rec.state !== 'pending') continue;
        try {
          await api.pending(identity, 'pending_cancel', { id: rec.id });
          if (rec.text.trim()) localTexts.push(rec.text);
          if (rec.attachments?.length) localAttIds.push(...rec.attachments);
        } catch {
          // 已发送则交由 Host withdrawQueued 处理
        }
      }
      let hostTexts: string[] = [];
      let hostAttIds: string[] = [];
      if (online && (live?.queuedItems?.length ?? 0) > 0) {
        const res = (await api.call(identity, 'withdrawQueued', {
          botId: bot.botId,
        })) as WithdrawQueuedResult;
        if (!isCurrentSession()) return;
        const withdrawn = Array.isArray(res?.withdrawn) ? res.withdrawn : [];
        hostTexts = withdrawn
          .map((w) => w.text)
          .filter((s) => typeof s === 'string' && s.trim().length > 0);
        hostAttIds = withdrawn.flatMap((w) => (Array.isArray(w.attachments) ? w.attachments : []));
      }
      const allTexts = [...hostTexts, ...localTexts];
      const allAttIds = [...hostAttIds, ...localAttIds];
      if (allTexts.length > 0 || allAttIds.length > 0) {
        const resolvedAtts = await resolveAttachmentMetasByIds(allAttIds, attachmentFetcher);
        if (!isCurrentSession()) return;
        if (drafts.mergeRecalled(allTexts, resolvedAtts, frozenDraftKey)) {
          window.setTimeout(() => composerRef.current?.focus(), 0);
        }
      }
      void refreshOutboxPending();
    } catch (e) {
      if (!isCurrentSession()) return;
      setSendError('撤回排队消息失败：' + tErr(e));
      reportUnlessTargetOffline(api, e);
    } finally {
      if (mountedRef.current) setQueueBusy(false);
    }
  }

  async function steerQueuedItem(item: UnifiedQueuedStripItem) {
    const curActivity = resolveBotActivity(live);
    if (
      !identity ||
      queueBusy ||
      item.source !== 'host' ||
      !canSteerBotActivity({ activity: curActivity, online, archived: isArchived, isStopping: stopping })
    ) {
      return;
    }
    setQueueBusy(true);
    try {
      await api.call(identity, 'steerQueued', {
        botId: bot.botId,
        requestId: item.requestId,
      });
    } catch (e) {
      if (!isCurrentSession()) return;
      if (toError(e).code !== 'SUBMISSION_NOT_FOUND') {
        setSendError('立即插入失败：' + tErr(e));
        reportUnlessTargetOffline(api, e);
      }
    } finally {
      if (mountedRef.current) setQueueBusy(false);
    }
  }

  // 只换 Bot 才清旧显示；断开保留最后读取的数据。
  useEffect(() => {
    rawCursorRef.current = null;
    setRawItems([]);
    setRawError(null);
  }, [bot.botId]);

  // 被动读取：离线不自动 call，重连后刷新。
  useEffect(() => {
    if (identity && api.transportConnected) void loadRaw();
  }, [loadRaw, identity, online]);

  // 重连/切换后被动刷新 Host 准入状态；离线保留最后显示，不自动请求。
  useEffect(() => {
    if (identity && api.transportConnected) void refreshTurnAdmission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, identity, online, bot.botId]);

  // Ctrl+F 会话内搜索 / Ctrl+. 工作台 由 BotChats 顶层 window 快捷键转发到此；全屏浏览器/弹窗开启时禁止误触发。
  const primaryShortcutBlockedRef = useRef(false);
  useEffect(() => {
    function onSearch() {
      if (!inspectorWorkspaceVisibleRef.current || primaryShortcutBlockedRef.current || hasBlockingWorkbenchOverlay()) return;
      setSearchOpen(true);
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    }
    function onInspector() {
      if (!inspectorWorkspaceVisibleRef.current || primaryShortcutBlockedRef.current || hasBlockingWorkbenchOverlay()) return;
      const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setInspectorTab((cur) => {
        if (cur) return null;
        if (activeEl) inspectorTriggerRef.current = activeEl;
        return 'profile';
      });
    }
    window.addEventListener('botchats:chat-search', onSearch);
    window.addEventListener('botchats:toggle-inspector', onInspector);
    return () => {
      window.removeEventListener('botchats:chat-search', onSearch);
      window.removeEventListener('botchats:toggle-inspector', onInspector);
    };
  }, []);

  useEffect(() => {
    if (!searchOpen) setChatSearch('');
  }, [searchOpen]);

  useEffect(() => {
    if (!pageActive) setSearchOpen(false);
  }, [pageActive]);

  const disabled =
    !readsActive || isArchived || sendState === 'sending' || slashBusy !== null || lockedRef.current || drafts.busy || !!drafts.attempt;
  useEffect(() => {
    if (!focusComposer || autoFocusedRef.current || !pageActive || !online || disabled) return;
    autoFocusedRef.current = true;
    if (document.activeElement === document.body) composerRef.current?.focus();
  }, [focusComposer, pageActive, online, disabled]);
  const sendRecordId = drafts.attempt ? drafts.attempt.pendingId : lastSendRecordId;
  const openSendRecord = onOpenSendRecords && (sendRecordId || drafts.attempt?.phase === 'unconfirmed')
    ? () => onOpenSendRecords({ deviceId: bot.deviceId, botId: bot.botId, recordId: sendRecordId ?? undefined })
    : undefined;

  // 正文从 Host 受理起显示任务活动；live 就绪后以 live.turnAdmission 为权威，未受理发送中不伪装成 queued。
  const effectiveTurnAdmission = live !== null ? readTurnAdmission(live.turnAdmission) : (rawLive !== null ? null : turnAdmission);
  const liveActivity = resolveBotActivity(live);
  const transcriptActivity: BotActivity =
    stopping && liveActivity.phase !== 'stopping' && liveActivity.phase !== 'interrupting'
      ? { ...liveActivity, phase: 'stopping' }
      : liveActivity;
  const acceptedPendingPreparing =
    live === null &&
    !stopping &&
    !isBotActivityBusy(transcriptActivity) &&
    effectiveTurnAdmission !== null &&
    effectiveTurnAdmission.phase !== 'failed';
  const activity: BotActivity = acceptedPendingPreparing
    ? {
        phase: 'preparing',
        source: effectiveTurnAdmission.source ?? 'primary',
        scopeId: null,
        requestId: effectiveTurnAdmission.requestId,
        startedAt: null,
        webhookStopPending: liveActivity.webhookStopPending,
      }
    : transcriptActivity;
  const liveBusy = isBotActivityBusy(activity);
  const canStop = canStopBotActivity(activity);
  const questionnaireLive = online && !isArchived && live !== null && !liveEnded && !liveError &&
    activity.phase !== 'stopping' && activity.phase !== 'interrupting';
  const pendingQuestionnaire = questionnaireLive && live.busy && activity.source !== 'room' && activity.source !== 'dm'
    ? readToolPresentation(live.tools?.find(tool => tool.status === 'running' &&
        tool.presentation?.kind === 'questionnaire' && tool.presentation.status === 'pending')?.presentation)
    : null;
  const hasDurableQuestionnaire = questionnaireLive && (live.durableWaits?.length ?? 0) > 0;
  const awaitingAnswer = pendingQuestionnaire?.kind === 'questionnaire'
    ? `等待你确认 · ${pendingQuestionnaire.questions.length} 题`
    : hasDurableQuestionnaire && !liveBusy ? t('等待你确认', 'Waiting for your answer') : null;
  const focusQuestionnaire = transcriptActive && questionnaireLive && questionnaireRequestId &&
    (live.busy || live.durableWaits?.some(wait => wait.requestId === questionnaireRequestId))
    ? questionnaireRequestId : undefined;
  // 停止独立门禁：只关联在线/归档/停止进行中，不被发送、草稿锁或附件上传禁用。
  const stopDisabled = !online || isArchived || stopping;
  // 主聊天任务直接停止并撤回排队消息到输入框；仅打断群聊/私信/后台任务时弹二次确认。
  const requiresStopConfirmation =
    liveActivity.source === 'room' ||
    liveActivity.source === 'dm' ||
    liveActivity.source === 'background';
  const stopTarget = JSON.stringify([sess, liveActivity.source, liveActivity.scopeId, liveActivity.requestId, liveActivity.startedAt]);
  const stopConfirmOpen = pageActive && canStop && !stopDisabled && confirmedStopTarget === stopTarget;
  useEffect(() => {
    if (!stopConfirmOpen) setConfirmedStopTarget(null);
  }, [stopConfirmOpen]);
  const receiptBusy =
    sendState === 'sending' ||
    Boolean(
      drafts.attempt &&
        !['not-sent', 'failed'].includes(drafts.attempt.phase) &&
        !drafts.conflict &&
        recOutcome?.action !== 'ready-clear-retry',
    );
  const isSendingMessage = receiptBusy && slashBusy === null;
  // 智能体忙碌时禁止发起或提交历史消息编辑；已打开的编辑草稿保留，待空闲后可重试或按 Esc 取消。
  const isBusyForEdit =
    liveBusy ||
    Boolean(live?.busy) ||
    (live?.queuedCount ?? 0) > 0 ||
    stopping ||
    isSendingMessage ||
    slashBusy !== null ||
    (effectiveTurnAdmission !== null && effectiveTurnAdmission.phase !== 'failed');
  const nativeHistoryLocked = hasAntigravityHistory(bot.modelRef, [...rawItems, ...(live?.history ?? [])], clearedThroughEntryId);
  const canEditTurns = Boolean(online && !nativeHistoryLocked && !isArchived && !isBusyForEdit && !editSubmitting && !disabled);
  useEffect(() => {
    if (!editingTurn || editSubmitting) return;
    if (
      editingTurn.sess !== sess ||
      editingTurn.botId !== bot.botId ||
      nativeHistoryLocked ||
      !online ||
      isArchived
    ) {
      setEditingTurn(null);
    }
  }, [editingTurn, editSubmitting, sess, bot.botId, nativeHistoryLocked, online, isArchived]);
  const startEditTurn = useCallback(
    (turn: ChatTurn) => {
      if (!canEditTurns) return;
      setSendError(null);
      setSendNotice(null);
      setEditingTurn({
        sess,
        botId: bot.botId,
        entryId: turn.entryId,
        text: turn.text ?? '',
        attachments: (turn.attachments ?? []).map((a) => ({ ...a })),
      });
      window.setTimeout(() => {
        const el = composerRef.current;
        if (!el) return;
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }, 0);
    },
    [canEditTurns, sess, bot.botId],
  );
  const queuedStripItems = useMemo(() => {
    const items = mergeQueuedStripItems(live?.queuedItems, outboxPendingItems, bot.botId, identity?.targetDeviceId);
    const hiddenIds = new Set<string>();
    if (effectiveTurnAdmission && effectiveTurnAdmission.phase !== 'queued') {
      hiddenIds.add(effectiveTurnAdmission.requestId);
    }
    if (liveActivity.phase === 'preparing' && liveActivity.requestId) {
      hiddenIds.add(liveActivity.requestId);
    }
    return hiddenIds.size > 0 ? items.filter((item) => !hiddenIds.has(item.requestId)) : items;
  }, [live?.queuedItems, outboxPendingItems, bot.botId, identity?.targetDeviceId, effectiveTurnAdmission, liveActivity.phase, liveActivity.requestId]);
  const composerText = activeEditing ? activeEditing.text : drafts.text;
  const composerAttachments = activeEditing ? activeEditing.attachments : drafts.attachments;
  const composerFiles = activeEditing ? [] : drafts.files;
  const desktopComposerAction = resolveComposerActionKind({
    phase: liveActivity.phase,
    online,
    archived: isArchived,
    isSending: isSendingMessage,
    isStopping: stopping,
    pendingAdmissionWaiting: live === null && effectiveTurnAdmission !== null && effectiveTurnAdmission.phase !== 'failed',
    hasDraft: composerText.trim().length > 0 || composerAttachments.length > 0,
    canStop,
  });
  const isStoppingPhase = desktopComposerAction === 'stopping';
  const isPreLlmPhase = desktopComposerAction === 'loading';
  const isLlmRunningPhase =
    !isArchived && !isStoppingPhase && !isPreLlmPhase && online && isBotLlmRunningPhase(liveActivity.phase);
  const canSteer = canSteerBotActivity({
    activity: liveActivity,
    online,
    archived: isArchived,
    isStopping: stopping || isStoppingPhase,
  });
  const showComposerStop = shouldShowComposerStop({
    phase: liveActivity.phase,
    online,
    archived: isArchived,
    isStopping: stopping,
    canStop,
  });
  const requestStop = () => {
    if (requiresStopConfirmation) setConfirmedStopTarget(stopTarget);
    else void stopTask();
  };
  void avatarVersion; // 头像保存后 bump：重新计算 key 下各 GrokBotAvatar preset

  const statusText = !online
    ? `目标 ${deviceName}（${bot.role}）离线：显示最后读取的数据`
    : liveError
      ? liveError
      : liveEnded
        ? '实时状态更新已暂停'
        : live
          ? awaitingAnswer ?? (
              isSendingMessage && !isBotActivityBusy(activity)
                ? (activity.webhookStopPending ? '发送中 · Webhook停止待同步' : '发送中')
                : botActivityText(activity, t)
            )
          : isSendingMessage
            ? '发送中'
            : '正在建立观察…';

  function openInspector(tab: InspectorTab, trigger?: HTMLElement | null) {
    const opener = trigger ?? (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setInspectorTab((cur) => {
      if (cur === tab) return null;
      if (tab === 'browser') {
        if (opener) browserTriggerRef.current = opener;
      } else if (cur === null || cur === 'browser') {
        if (opener) inspectorTriggerRef.current = opener;
      }
      return tab;
    });
  }

  const inspectorPage = inspectorPages.find(page => page.id === inspectorTab);
  const isProfilePage = inspectorTab === 'profile';
  const isManagementPage = inspectorTab === 'management';
  const pendingBrowserTakeover = online && !isArchived && live?.busy && !liveEnded && !liveError
    ? (live.tools
        ?.map(tool => (tool.status === 'running' ? readToolPresentation(tool.presentation) : null))
        .find(pres => pres?.kind === 'google-browser-takeover') ?? null)
    : null;
  const settingsTab = inspectorPage && inspectorPage.id !== 'management' ? inspectorPage.id : null;
  primaryShortcutBlockedRef.current = browserOpen || stopConfirmOpen || confirmArchive || confirmDelete || confirmClear;
  const inspectorTitle = inspectorPage?.label ??
    (isProfilePage
      ? 'Bot 资料'
      : inspectorTab === 'raw'
        ? '诊断与原始记录'
        : inspectorTab === 'google-setup' ? t('Google 配置向导', 'Google setup wizard')
        : '虚拟桌面');
  const managementError = manageError ? (
    <InlineBanner
      compact
      tone="danger"
      className={isManagementPage ? undefined : 'chat-top-banner'}
      title={manageError}
      onDismiss={() => setManageError(null)}
    />
  ) : null;
  const chatMoreMenuItems: PopoverMenuItem[] = [
    {
      key: 'view-profile',
      label: t('查看完整资料', 'Bot settings & profile'),
      icon: <User size={16} aria-hidden="true" />,
      onSelect: () => openInspector('profile', moreMenuButtonRef.current),
    },
    ...(onOpenPrivateChats
      ? [
          {
            key: 'view-dm',
            label: t('查看 Bot 间私聊', 'View bot direct messages'),
            icon: <MessageSquare size={16} aria-hidden="true" />,
            onSelect: () => onOpenPrivateChats(bot),
          } satisfies PopoverMenuItem,
        ]
      : []),
    {
      key: 'set-primary',
      label: manageAction === 'setPrimary' ? t('设置中…', 'Setting…') : t('设为主 Bot', 'Set as primary bot'),
      icon: <Star size={16} aria-hidden="true" />,
      disabled: !online || manageBusy || isPrimary || isArchived,
      onSelect: () => void handleSetPrimary(),
    },
    !isArchived
      ? {
          key: 'archive-bot',
          label: t('归档 Bot', 'Archive bot'),
          icon: <Archive size={16} aria-hidden="true" />,
          disabled: !online || manageBusy || isPrimary,
          onSelect: () => {
            confirmTriggerRef.current = moreMenuButtonRef.current;
            setManageError(null);
            setConfirmArchive(true);
          },
        }
      : {
          key: 'unarchive-bot',
          label: manageAction === 'unarchive' ? t('恢复中…', 'Restoring…') : t('恢复 Bot', 'Restore bot'),
          icon: <RotateCcw size={16} aria-hidden="true" />,
          disabled: !online || manageBusy,
          onSelect: () => void handleUnarchive(),
        },
    {
      key: 'raw-history',
      label: t('诊断与原始记录', 'Diagnostics & raw history'),
      icon: <History size={16} aria-hidden="true" />,
      separatorBefore: true,
      onSelect: () => openInspector('raw', moreMenuButtonRef.current),
    },
    {
      key: 'delete-bot',
      label: t('永久删除 Bot', 'Delete bot permanently'),
      icon: <Trash2 size={16} aria-hidden="true" />,
      danger: true,
      separatorBefore: true,
      disabled: !online || manageBusy || isPrimary,
      onSelect: () => {
        confirmTriggerRef.current = moreMenuButtonRef.current;
        setManageError(null);
        setConfirmDelete(true);
      },
    },
  ];
  const hasTaskPrompt = Boolean(
    !isArchived &&
    bannerTask &&
    isTaskWaitingForBot(bannerTask, bot.deviceId, bot.botId) &&
    bannerTask.pendingPrompt,
  );
  const hasTaskQuote = !isArchived && !hasTaskPrompt && Boolean(resolvedTaskContext.showQuoteStrip && bannerTask);
  const primaryDockItems = useMemo<ConditionDockItem[]>(() => {
    if (isArchived) return [];
    const items: ConditionDockItem[] = [];

    if (taskActionFailure) {
      const failureText =
        taskActionFailure.kind === 'answer_prompt'
          ? `任务「${taskActionFailure.taskTitle}」澄清答复未同步（聊天消息已发出）：${taskActionFailure.error}`
          : taskActionFailure.kind === 'confirm_plan'
            ? `任务「${taskActionFailure.taskTitle}」确认计划失败：${taskActionFailure.error}`
            : `任务「${taskActionFailure.taskTitle}」任务备注未同步（聊天消息已发出）：${taskActionFailure.error}`;
      items.push({
        id: 'task-action-failure',
        priority: 90,
        tone: 'danger',
        label: '任务同步失败',
        defaultExpanded: true,
        render: () => (
          <InlineBanner
            compact
            tone="danger"
            role="alert"
            title={failureText}
            actions={
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={taskActionRetrying}
                  onClick={() => onRetryTaskAction?.()}
                >
                  {taskActionRetrying ? '重试中…' : '仅重试任务动作'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={taskActionRetrying}
                  onClick={() => onDismissTaskAction?.()}
                >
                  忽略
                </button>
              </>
            }
          />
        ),
      });
    }

    if (pendingBrowserTakeover && !(hasGoogleSetupDock && inspectorTab !== 'google-setup' && googleSetupBrowserTakeoverActive)) {
      items.push({
        id: 'browser-takeover',
        priority: 85,
        tone: 'attention',
        label: '浏览器待接管',
        defaultExpanded: true,
        render: () => (
          <InlineBanner
            compact
            tone="attention"
            role="status"
            title={pendingBrowserTakeover.reason || 'Bot 请求你接管内置浏览器完成登录或验证'}
            actions={
              <button
                type="button"
                className="primary-button"
                onClick={(event) => openInspector('browser', event.currentTarget)}
              >
                <Globe size={14} aria-hidden="true" /> 打开浏览器
              </button>
            }
          />
        ),
      });
    }

    if (hasTaskPrompt && bannerTask?.pendingPrompt) {
      const promptKind = bannerTask.pendingPrompt.kind;
      items.push({
        id: 'task-prompt',
        priority: 80,
        tone: 'attention',
        label: promptKind === 'plan' ? '待确认安排' : '待你回应',
        badge:
          resolvedTaskContext.waitingTasks.length > 1
            ? `${resolvedTaskContext.waitingIndex + 1}/${resolvedTaskContext.waitingTasks.length}`
            : undefined,
        defaultExpanded: true,
        render: () => (
          <TaskChatPromptBanner
            variant="desktop"
            embeddedInDock
            botDeviceId={bot.deviceId}
            botId={bot.botId}
            task={bannerTask}
            focusedStep={focusedStep}
            showQuoteStrip={resolvedTaskContext.showQuoteStrip}
            waitingTasksCount={resolvedTaskContext.waitingTasks.length}
            waitingTaskIndex={resolvedTaskContext.waitingIndex}
            bots={taskBots}
            busy={taskBannerBusy}
            onClearQuote={onClearTaskQuote}
            onCycleWaitingTask={onCycleWaitingTask}
            onConfirmPlan={async (taskId, expectedRevision) => {
              if (!onRunTaskAction) return;
              setTaskBannerBusy(true);
              try {
                const target = tasks.find((item) => item.id === taskId);
                await onRunTaskAction(
                  {
                    kind: 'confirm_plan',
                    scopeKey: taskScopeKey,
                    botKey: `${bot.deviceId}:${bot.botId}`,
                    taskId,
                    taskTitle: target?.title ?? taskId,
                    expectedRevision,
                  },
                  { rethrow: true },
                );
              } finally {
                setTaskBannerBusy(false);
              }
            }}
            onOpenTaskDetail={(taskId, openEdit) => onOpenTask?.(taskId, openEdit)}
            onAnswerPrompt={async (taskId, answer, expectedRevision) => {
              if (!onRunTaskAction) return;
              setTaskBannerBusy(true);
              try {
                const target = tasks.find((item) => item.id === taskId);
                await onRunTaskAction(
                  {
                    kind: 'answer_prompt',
                    scopeKey: taskScopeKey,
                    botKey: `${bot.deviceId}:${bot.botId}`,
                    taskId,
                    taskTitle: target?.title ?? taskId,
                    answer,
                    expectedRevision,
                  },
                  { rethrow: true },
                );
              } finally {
                setTaskBannerBusy(false);
              }
            }}
          />
        ),
      });
    }

    if (hasGoogleSetupDock && googleSetupSlotEl && inspectorTab !== 'google-setup') {
      items.push({
        id: 'google-setup',
        priority: 60,
        tone: googleSetupAttention ? 'attention' : 'info',
        label: 'Google 配置',
        defaultExpanded: true,
        render: () => (
          <GoogleSetupSlotHost
            slotEl={googleSetupSlotEl}
            parkingRef={googleSetupParkingRef}
          />
        ),
      });
    }

    if (hasTaskQuote && bannerTask) {
      items.push({
        id: 'task-quote',
        priority: 10,
        tone: 'neutral',
        label: '关联任务',
        defaultExpanded: true,
        render: () => (
          <TaskChatPromptBanner
            variant="desktop"
            embeddedInDock
            botDeviceId={bot.deviceId}
            botId={bot.botId}
            task={bannerTask}
            focusedStep={focusedStep}
            showQuoteStrip={resolvedTaskContext.showQuoteStrip}
            waitingTasksCount={resolvedTaskContext.waitingTasks.length}
            waitingTaskIndex={resolvedTaskContext.waitingIndex}
            bots={taskBots}
            busy={taskBannerBusy}
            onClearQuote={onClearTaskQuote}
            onCycleWaitingTask={onCycleWaitingTask}
            onConfirmPlan={async (taskId, expectedRevision) => {
              if (!onRunTaskAction) return;
              setTaskBannerBusy(true);
              try {
                const target = tasks.find((item) => item.id === taskId);
                await onRunTaskAction(
                  {
                    kind: 'confirm_plan',
                    scopeKey: taskScopeKey,
                    botKey: `${bot.deviceId}:${bot.botId}`,
                    taskId,
                    taskTitle: target?.title ?? taskId,
                    expectedRevision,
                  },
                  { rethrow: true },
                );
              } finally {
                setTaskBannerBusy(false);
              }
            }}
            onOpenTaskDetail={(taskId, openEdit) => onOpenTask?.(taskId, openEdit)}
            onAnswerPrompt={async (taskId, answer, expectedRevision) => {
              if (!onRunTaskAction) return;
              setTaskBannerBusy(true);
              try {
                const target = tasks.find((item) => item.id === taskId);
                await onRunTaskAction(
                  {
                    kind: 'answer_prompt',
                    scopeKey: taskScopeKey,
                    botKey: `${bot.deviceId}:${bot.botId}`,
                    taskId,
                    taskTitle: target?.title ?? taskId,
                    answer,
                    expectedRevision,
                  },
                  { rethrow: true },
                );
              } finally {
                setTaskBannerBusy(false);
              }
            }}
          />
        ),
      });
    }

    return items;
  }, [
    isArchived,
    taskActionFailure,
    taskActionRetrying,
    onRetryTaskAction,
    onDismissTaskAction,
    pendingBrowserTakeover,
    hasTaskPrompt,
    hasTaskQuote,
    bannerTask,
    bot.deviceId,
    bot.botId,
    focusedStep,
    resolvedTaskContext.showQuoteStrip,
    resolvedTaskContext.waitingTasks.length,
    resolvedTaskContext.waitingIndex,
    taskBots,
    taskBannerBusy,
    onClearTaskQuote,
    onCycleWaitingTask,
    onRunTaskAction,
    tasks,
    taskScopeKey,
    onOpenTask,
    hasGoogleSetupDock,
    googleSetupAttention,
    googleSetupBrowserTakeoverActive,
    googleSetupSlotEl,
    inspectorTab,
  ]);
  const example = '帮我梳理今天的待办事项。';
  const connectedToCenter = Boolean(centerApi.identity?.kind === 'relay' && centerApi.transportConnected && !centerInterrupted);
  const modelSummary = formatBotModelSummary(bot as DesktopBotDirectoryEntry, { connectedToCenter });

  return (
    <div className="chat-stage" ref={setStageRef}>
      <div className="chat-column">
      {chatBoard.storageError ? (
        <InlineBanner compact tone="attention" role="alert" className="chat-top-banner" title={chatBoard.storageError} />
      ) : null}
      <header className="chat-header">
        {listCollapsed && onExpandSidebar ? (
          <button
            ref={expandSidebarButtonRef}
            type="button"
            className="icon-button sidebar-reopen-btn"
            onClick={onExpandSidebar}
            aria-label={t('展开会话列表', 'Expand conversation list')}
            aria-expanded={false}
            title={t(`展开会话列表（${SHORTCUT_MOD_LABEL}B）`, `Expand conversation list (${SHORTCUT_MOD_LABEL}B)`)}
          >
            <PanelLeftOpen size={16} aria-hidden="true" />
          </button>
        ) : null}
        {returnTaskId && onReturnToTask ? (
          <button
            type="button"
            className="secondary-button chat-action-pill"
            onClick={() => onReturnToTask(returnTaskId)}
            title={t('返回刚才查看的任务详情', 'Return to task details')}
          >
            <ArrowLeft size={15} aria-hidden="true" /> {t('返回任务', 'Back to task')}
          </button>
        ) : null}
        <button
          type="button"
          className="chat-header-pill"
          onClick={(event) => openInspector('profile', event.currentTarget)}
          aria-label={t(`打开${bot.role}的 Bot 设置`, `Open settings for ${bot.role}`)}
          aria-haspopup="dialog"
          aria-expanded={inspectorDialogOpen}
          title={t(`Bot 设置（${SHORTCUT_MOD_LABEL}.）`, `Bot settings (${SHORTCUT_MOD_LABEL}.)`)}
        >
          <GrokBotAvatar
            botKey={botAvatarKey(bot)}
            roleName={bot.role}
            isPrimary={isPrimary && !isArchived}
            starBadge={isPrimary && !isArchived}
            platformBadge={devicePlatform}
            busy={liveBusy}
            reflecting={Boolean(live?.learning?.active)}
            offline={!online}
            size={30}
          />
          <span className="chat-header-pill-text">
            <span className="chat-header-pill-name-row">
              <span className="chat-header-pill-name">
                {isPrimary && !isArchived ? '★ ' : ''}{bot.role}
              </span>
              {isArchived ? <span className="archived-pill">{t('已归档', 'Archived')}</span> : null}
            </span>
            <span className="chat-header-pill-sub">
              {deviceName} · <span className={modelSummary.tone === 'warn' ? 'model-summary-warn' : undefined}>{modelSummary.headerText}</span>
            </span>
          </span>
          <span
            className={`live-dot${liveBusy ? ' busy' : online && !liveError ? ' online' : ''}`}
            title={statusText}
            aria-label={statusText}
          />
          <Settings className="chat-header-settings-icon" size={15} aria-hidden="true" />
        </button>

        <div className="chat-header-actions">
          {searchOpen ? (
            <div className="chat-search-bar">
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchInputRef}
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setSearchOpen(false);
                    setChatSearch('');
                    window.setTimeout(() => searchButtonRef.current?.focus(), 0);
                  }
                }}
                placeholder={t('搜索本会话…', 'Search this conversation…')}
                aria-label={t('会话内搜索', 'Search in conversation')}
              />
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  setSearchOpen(false);
                  setChatSearch('');
                  window.setTimeout(() => searchButtonRef.current?.focus(), 0);
                }}
                aria-label={t('关闭搜索', 'Close search')}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <button
              ref={searchButtonRef}
              type="button"
              className="icon-button"
              onClick={() => {
                setSearchOpen(true);
                window.setTimeout(() => searchInputRef.current?.focus(), 0);
              }}
              title={t(`会话内搜索（${SHORTCUT_MOD_LABEL}F）`, `Search in conversation (${SHORTCUT_MOD_LABEL}F)`)}
              aria-label={t('会话内搜索', 'Search in conversation')}
            >
              <Search size={17} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className={`secondary-button chat-action-pill${inspectorTab === 'browser' ? ' active' : ''}`}
            onClick={(event) => openInspector('browser', event.currentTarget)}
            title={t('Bot 内置浏览器（仅本 Bot 独立会话，与 Google API 授权隔离）', 'Built-in bot browser (isolated session per bot)')}
          >
            <Globe size={15} aria-hidden="true" /> {pendingBrowserTakeover ? t('浏览器 · 待接管', 'Browser · Takeover') : t('浏览器', 'Browser')}
          </button>
          <button
            type="button"
            className={`secondary-button chat-action-pill${inspectorTab === 'shower' ? ' active' : ''}`}
            onClick={(event) => openInspector('shower', event.currentTarget)}
            title={t('虚拟桌面（右侧工作台 / 全窗口模式在面板内切换）', 'Virtual desktop (switch docked / theater mode inside panel)')}
          >
            <Monitor size={15} aria-hidden="true" /> {t('桌面', 'Desktop')}
          </button>
          <PopoverMenu
            align="end"
            side="bottom"
            ariaLabel={t('更多操作', 'More actions')}
            items={chatMoreMenuItems}
            trigger={({ triggerProps }) => (
              <button
                {...triggerProps}
                ref={(el) => {
                  moreMenuButtonRef.current = el;
                  triggerProps.ref(el);
                }}
                type="button"
                className="icon-button"
                aria-label={t('更多操作', 'More actions')}
                title={t('更多操作', 'More actions')}
              >
                <MoreHorizontal size={17} aria-hidden="true" />
              </button>
            )}
          />
        </div>
      </header>

      {awaitingAnswer ? <p className="chat-awaiting-answer" role="status">{awaitingAnswer}</p> : null}

      {isManagementPage ? null : managementError}

      {liveEnded && online && !liveError && !rawError ? (
        <InlineBanner
          compact
          tone="neutral"
          role="status"
          className="chat-top-banner"
          title={t('实时状态更新已暂停，不影响 Bot 继续运行。', 'Live status updates paused; the bot continues running.')}
          actions={
            <button
              type="button"
              className="secondary-button"
              onClick={() => setWatchTick((n) => n + 1)}
            >
              {t('重新同步', 'Reconnect stream')}
            </button>
          }
        />
      ) : null}
      {!online && readsActive && !centerInterrupted ? (
        <InlineBanner
          compact
          tone="attention"
          role="status"
          className="chat-top-banner"
          title={identity ? t(`${deviceName}（${bot.role}）当前离线`, `${deviceName} (${bot.role}) is offline`) : t('当前连接已断开', 'Disconnected')}
          detail={t('正在显示最后同步的只读记录，草稿已保留；恢复在线后可继续发送。', 'Showing last synced read-only history; draft kept until back online.')}
        />
      ) : null}

      <ChatTranscript
        entries={rawItems}
        live={live}
        clearedThroughEntryId={clearedThroughEntryId}
        bot={bot}
        knownBots={knownBots}
        activity={transcriptActivity}
        awaitingAnswer={Boolean(awaitingAnswer)}
        avatarKey={botAvatarKey(bot)}
        devicePlatform={devicePlatform}
        search={chatSearch}
        boardResultId={boardResultId}
        onViewedResult={onViewedResult}
        questionnaireRequestId={focusQuestionnaire}
        onQuestionnaireFocused={onQuestionnaireFocused}
        archived={isArchived}
        scopeKey={toolScopeKey}
        disabled={!online}
        onSubmitQuestionnaire={submitQuestionnaire}
        onSubmitVaultUnlock={submitVaultUnlock}
        googleContext={googleContext}
        googleSetupSlotContainer={isArchived || inspectorTab === 'google-setup' ? null : googleSetupSlotEl}
        onGoogleSetupBrowserTakeoverActiveChange={setGoogleSetupBrowserTakeoverActive}
        attachmentFetcher={attachmentFetcher}
        loading={online && rawLoading}
        error={online ? (rawError || liveError) : null}
        hasMore={false}
        onLoadMore={() => void loadRaw()}
        onRetry={() => {
          setLiveError(null);
          setWatchTick((n) => n + 1);
          void loadRaw();
        }}
        onOpenLearnedSkills={() => openInspector('skills')}
        canEditTurns={canEditTurns}
        editingEntryId={activeEditing?.entryId ?? null}
        onEditTurn={startEditTurn}
        onOpenTask={onOpenTask}
        onConfirmTaskPlan={
          !isArchived && onRunTaskAction
            ? async (taskId) => {
                const target = tasks.find((item) => item.id === taskId);
                await onRunTaskAction(
                  {
                    kind: 'confirm_plan',
                    scopeKey: taskScopeKey,
                    botKey: `${bot.deviceId}:${bot.botId}`,
                    taskId,
                    taskTitle: target?.title ?? taskId,
                    expectedRevision: target?.revision,
                  },
                  { rethrow: true },
                );
              }
            : undefined
        }
        onAnswerTaskPrompt={
          !isArchived && onRunTaskAction
            ? async (taskId, answer) => {
                const target = tasks.find((item) => item.id === taskId);
                await onRunTaskAction(
                  {
                    kind: 'answer_prompt',
                    scopeKey: taskScopeKey,
                    botKey: `${bot.deviceId}:${bot.botId}`,
                    taskId,
                    taskTitle: target?.title ?? taskId,
                    answer,
                    expectedRevision: target?.revision,
                  },
                  { rethrow: true },
                );
              }
            : undefined
        }
        emptyActions={
          !isArchived && !drafts.text && <button
            type="button"
            className="secondary-button"
            disabled={disabled || !drafts.key}
            onClick={() => { onChangeText(example); composerRef.current?.focus(); }}
          >{example}</button>
        }
      />

      <div ref={googleSetupParkingRef} hidden aria-hidden="true" />

      {isArchived ? (
        <>
          {primaryDockItems.length > 0 ? (
            <ConditionDock items={primaryDockItems} className="bot-condition-dock bot-condition-dock-archived" />
          ) : null}
          <footer className="archived-readonly-footer" role="status" aria-label={t('已归档只读状态', 'Archived read-only status')}>
            <div className="archived-readonly-copy">
              <span className="archived-readonly-title">{t('此 Bot 已归档，当前为只读历史', 'This bot is archived (read-only history)')}</span>
              <span className="archived-readonly-detail">
                {t(`剩余 ${remainingArchiveDays(bot.archivedAt)} 天后自动清理`, `Auto-deletes in ${remainingArchiveDays(bot.archivedAt)} days`)}
                {bot.archivedAt ? t(` · 归档于 ${formatTime(bot.archivedAt)}`, ` · archived ${formatTime(bot.archivedAt)}`) : ''}
              </span>
            </div>
            <div className="archived-readonly-actions">
              <button
                type="button"
                className="primary-button"
                disabled={!online || manageBusy}
                onClick={() => void handleUnarchive()}
              >
                <RotateCcw size={14} aria-hidden="true" />
                {manageAction === 'unarchive' ? t('恢复中…', 'Restoring…') : t('恢复 Bot', 'Restore bot')}
              </button>
              {!isPrimary ? (
                <button
                  type="button"
                  className="secondary-button danger-outline"
                  disabled={!online || manageBusy}
                  onClick={(event) => {
                    confirmTriggerRef.current = event.currentTarget;
                    setManageError(null);
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  {t('永久删除 Bot', 'Delete bot permanently')}
                </button>
              ) : null}
            </div>
          </footer>
        </>
      ) : (
        <Composer
          textareaRef={composerRef}
          text={composerText}
          onChangeText={onChangeText}
          files={composerFiles}
          onRemoveFile={removeFile}
          attachments={composerAttachments}
          onRemoveAttachment={removeAttachment}
          attachmentFetcher={attachmentFetcher}
          onPickImage={pickImage}
          hasNativeClipboardImage={Boolean(api.pickImages)}
          canPick={!isArchived && !activeEditing && identity?.kind === 'local'}
          onPick={pickFile}
          draftError={activeEditing ? null : drafts.error}
          draftHint={null}
          draftConflict={activeEditing ? null : drafts.conflict}
          sendState={sendState}
          receiptBusy={receiptBusy}
          sendError={sendError}
          sendNotice={sendNotice}
          onSend={(delivery) => void handleSend(delivery)}
          canSend={
            activeEditing
              ? online &&
                !isArchived &&
                !isBusyForEdit &&
                !editSubmitting &&
                !imageUploading &&
                (activeEditing.text.trim().length > 0 || activeEditing.attachments.length > 0)
              : !isArchived &&
                !isPreLlmPhase &&
                !isStoppingPhase &&
                !!identity &&
                !!drafts.key &&
                (drafts.text.trim().length > 0 || drafts.attachments.length > 0) &&
                !drafts.attempt &&
                !drafts.savePaused &&
                !imageUploading
          }
          disabled={disabled}
          isPreLlm={isPreLlmPhase}
          isLlmRunning={isLlmRunningPhase}
          canSteer={canSteer}
          isStopping={isStoppingPhase}
          canStop={showComposerStop}
          stopDisabled={stopDisabled}
          onStop={requestStop}
          stopButtonRef={stopButtonRef}
          onRetryDraft={drafts.retrySave}
          attempt={activeEditing ? null : drafts.attempt}
          recOutcome={activeEditing ? null : recOutcome}
          onReleaseNotSent={releaseNotSent}
          onRetryClearVerified={retryClearVerified}
          onAdoptNewerDraft={adoptNewerDraft}
          onAdoptPersistedDraft={() => void adoptPersistedDraft()}
          turnAdmission={activeEditing ? null : effectiveTurnAdmission}
          onRetryTurnAdmission={() => void retryTurnAdmission()}
          onRestoreTurnAdmission={() => void restoreFailedTurnAdmission()}
          canRestoreTurnAdmission={Boolean(!activeEditing && effectiveTurnAdmission?.phase === 'failed' && online && !isArchived && !queueBusy && !stopping && sendState === 'idle')}
          canCancelTurnAdmission={Boolean(!activeEditing && effectiveTurnAdmission?.phase === 'failed' && canStop && !stopDisabled)}
          onInsertSlash={(cmd) => drafts.editText(cmd)}
          onOpenSendRecord={activeEditing ? undefined : openSendRecord}
          queuedItems={queuedStripItems}
          queueBusy={queueBusy}
          onRecallQueued={(item) => void recallQueuedItem(item, true)}
          onRecallAllQueued={() => void recallAllQueued()}
          onDiscardQueued={(item) => void recallQueuedItem(item, false)}
          onSteerQueued={canSteer ? ((item) => void steerQueuedItem(item)) : undefined}
          isEditingTurn={Boolean(activeEditing)}
          onCancelEditTurn={() => {
            setEditingTurn(null);
            setSendError(null);
            window.setTimeout(() => composerRef.current?.focus(), 0);
          }}
          extraDockItems={primaryDockItems}
        />
      )}
      </div>

      <Dialog.Root open={stopConfirmOpen} onOpenChange={open => {
        if (!open) setConfirmedStopTarget(null);
      }}>
        <Dialog.Portal>
          <Dialog.Overlay className="desktop-dialog-overlay" />
          <Dialog.Content
            className="desktop-dialog confirm-action-dialog"
            {...FLOATING_OUTSIDE_GUARD_PROPS}
            onEscapeKeyDown={(event) => {
              if (hasOpenFloatingPopover()) event.preventDefault();
            }}
            onCloseAutoFocus={event => {
              event.preventDefault();
              if (!inspectorWorkspaceVisibleRef.current) return;
              if (stopButtonRef.current && !stopButtonRef.current.disabled) stopButtonRef.current.focus();
              else stageRef.current?.querySelector<HTMLButtonElement>('.chat-header-pill')?.focus();
            }}
          >
            <div className="desktop-dialog-head"><Dialog.Title>{t('停止 Bot 任务', 'Stop bot tasks')}</Dialog.Title></div>
            <div className="confirm-action-body">
              <Dialog.Description>{t(`停止「${bot.role}」的所有进行中和排队任务，包括其他会话和后台任务。`, `Stop all active and queued tasks for "${bot.role}", including other chats and background tasks.`)}</Dialog.Description>
              <ActionBar align="end" className="form-actions">
                <Dialog.Close asChild><button type="button" className="secondary-button">{t('取消', 'Cancel')}</button></Dialog.Close>
                <button type="button" className="primary-button danger-button" onClick={() => {
                  if (!stopConfirmOpen) return;
                  setConfirmedStopTarget(null);
                  void stopTask();
                }}>{t('停止 Bot 任务', 'Stop bot tasks')}</button>
              </ActionBar>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={Boolean(stageEl) && inspectorDialogOpen}
        modal={compactOverlay}
        onOpenChange={(open) => {
          if (!open && inspectorWorkspaceVisibleRef.current) setInspectorTab(null);
        }}
      >
        <Dialog.Portal container={stageEl}>
          <Dialog.Overlay className="inspector-scrim" />
          <Dialog.Content
            ref={inspectorContentRef}
            className="inspector-drawer"
            {...FLOATING_OUTSIDE_GUARD_PROPS}
            onEscapeKeyDown={(event) => {
              const target = event.target instanceof Element ? event.target : null;
              if (
                hasOpenFloatingPopover() ||
                Boolean(document.querySelector('[data-shower-overlay], [data-shower-takeover="true"]')) ||
                Boolean(target?.closest('[data-shower-overlay], [data-shower-takeover="true"]'))
              ) {
                event.preventDefault();
                return;
              }
              if (
                !compactOverlay &&
                target &&
                inspectorContentRef.current &&
                !inspectorContentRef.current.contains(target)
              ) {
                event.preventDefault();
              }
            }}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              inspectorContentRef.current?.focus();
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              const opener = inspectorTriggerRef.current;
              inspectorTriggerRef.current = null;
              if (!inspectorWorkspaceVisibleRef.current) return;
              if (opener?.isConnected) {
                opener.focus();
              } else {
                stageRef.current?.querySelector<HTMLButtonElement>('.chat-header-pill')?.focus();
              }
            }}
          >
            <div className="inspector-head">
              {inspectorPage ? (
                <button type="button" className="icon-button" aria-label="返回资料" onClick={() => setInspectorTab('profile')}>
                  <ArrowLeft size={16} aria-hidden="true" />
                </button>
              ) : null}
              <Dialog.Title className="inspector-title" ref={inspectorTitleRef} tabIndex={-1} aria-label={`${bot.role} · ${inspectorTitle}`}>
                {isProfilePage || inspectorPage ? inspectorTitle : `${bot.role} · ${inspectorTitle}`}
              </Dialog.Title>
              <Dialog.Description className="sr-only">
                查看并管理 Bot「{bot.role}」的资料、模型、人设与扩展工具。
              </Dialog.Description>
              <button
                type="button"
                className="icon-button"
                onClick={() => setInspectorTab(null)}
                aria-label="关闭工作台"
                title={`关闭工作台（${SHORTCUT_MOD_LABEL}.）`}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="inspector-body" ref={inspectorBodyRef} onScroll={(event) => {
              if (isProfilePage) profileScrollRef.current = event.currentTarget.scrollTop;
            }}>
              <div className="inspector-section" hidden={!isProfilePage && !isManagementPage}>
                {isProfilePage ? <p className="metadata inspector-device">设备 · {deviceName}</p> : null}
                <div className="bot-avatar-studio" hidden={!isProfilePage}>
                  <BotAvatarStudio
                    api={api}
                    deviceId={bot.deviceId}
                    botId={bot.botId}
                    key={botAvatarKey(bot)}
                    botKey={botAvatarKey(bot)}
                    roleName={bot.role}
                    isPrimary={isPrimary && !isArchived}
                    onChanged={() => { setAvatarVersion((v) => v + 1); onLiveActivity?.(); }}
                  />
                </div>
                <BotProfile api={api} centerApi={centerApi} bot={bot} page={isManagementPage ? 'management' : 'profile'} onSaved={onProfileSaved} />
                {isProfilePage ? (
                  <nav className="inspector-links" aria-label={t('Bot 设置', 'Bot settings')}>
                    {onOpenPrivateChats ? (
                      <section className="inspector-link-group">
                        <h3 className="inspector-section-title">{t('Bot 协作', 'Bot collaboration')}</h3>
                        <button
                          type="button"
                          className="inspector-dm-entry"
                          onClick={() => {
                            setInspectorTab(null);
                            onOpenPrivateChats(bot);
                          }}
                        >
                          <span className="inspector-dm-icon" aria-hidden="true">
                            <MessagesSquare size={16} />
                          </span>
                          <span className="inspector-dm-copy">
                            <span className="inspector-dm-title">{t('查看该 Bot 的私聊', 'View this bot’s private chats')}</span>
                            <span className="inspector-dm-sub">
                              {t('查看与其他 Bot 的收发私聊记录', 'Browse incoming & outgoing peer bot DMs')}
                            </span>
                          </span>
                          <ChevronRight size={15} className="inspector-dm-chevron" aria-hidden="true" />
                        </button>
                      </section>
                    ) : null}
                    {inspectorGroups.map(group => (
                      <section className="inspector-link-group" key={group.title}>
                        <h3 className="inspector-section-title">{group.title}</h3>
                        {group.pages.map(({ id, label, Icon }) => (
                          <button
                            key={id}
                            type="button"
                            className="inspector-link"
                            data-inspector-page={id}
                            onClick={() => {
                              profileScrollRef.current = inspectorBodyRef.current?.scrollTop ?? 0;
                              setInspectorTab(id);
                            }}
                          >
                            <Icon size={17} aria-hidden="true" />
                            <span className="inspector-link-label">{label}</span>
                            {id === 'model' ? (
                              <span className={'inspector-link-value' + (modelSummary.tone === 'warn' ? ' model-summary-warn' : ' metadata')}>
                                <span className="inspector-model-name" title={modelSummary.primaryText}>
                                  {modelSummary.primaryText}
                                </span>
                                {modelSummary.badgeText ? <span className="inspector-default-pill">{modelSummary.badgeText}</span> : null}
                              </span>
                            ) : null}
                            <ChevronRight size={15} aria-hidden="true" />
                          </button>
                        ))}
                      </section>
                    ))}
                  </nav>
                ) : null}
                {isManagementPage ? (
                  <section className="inspector-lifecycle" aria-label="更多管理">
                    <h3 className="inspector-section-title">会话与生命周期</h3>
                    {isPrimary && !isArchived ? (
                      <p className="hint">主 Bot 不可归档或删除，请先将其他 Bot 设为主 Bot。</p>
                    ) : null}
                    <ActionBar align="start" className="form-actions">
                      {!isPrimary && !isArchived ? (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={!online || manageBusy}
                          onClick={() => void handleSetPrimary()}
                        >
                          {manageAction === 'setPrimary' ? t('设置中…', 'Setting…') : t('★ 设为主 Bot', '★ Set as primary bot')}
                        </button>
                      ) : null}
                      {!isArchived ? (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={!online || manageBusy || slashBusy !== null || liveBusy}
                          onClick={(event) => {
                            confirmTriggerRef.current = event.currentTarget;
                            setManageError(null);
                            setConfirmArchive(false);
                            setConfirmDelete(false);
                            setConfirmClear(true);
                          }}
                        >
                          {manageAction === 'clear' ? t('清空中…', 'Clearing…') : t('清空对话', 'Clear conversation')}
                        </button>
                      ) : null}
                      {!isArchived ? (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={!online || manageBusy || isPrimary}
                          onClick={(event) => {
                            confirmTriggerRef.current = event.currentTarget;
                            setManageError(null);
                            setConfirmClear(false);
                            setConfirmDelete(false);
                            setConfirmArchive(true);
                          }}
                        >
                          {manageAction === 'archive' ? t('正在归档…', 'Archiving…') : t('归档 Bot', 'Archive bot')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={!online || manageBusy}
                          onClick={() => void handleUnarchive()}
                        >
                          {manageAction === 'unarchive' ? t('恢复中…', 'Restoring…') : t('恢复 Bot', 'Restore bot')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="secondary-button danger-outline"
                        disabled={!online || manageBusy || isPrimary}
                        onClick={(event) => {
                          confirmTriggerRef.current = event.currentTarget;
                          setManageError(null);
                          setConfirmArchive(false);
                          setConfirmClear(false);
                          setConfirmDelete(true);
                        }}
                      >
                        {t('永久删除 Bot', 'Delete bot permanently')}
                      </button>
                    </ActionBar>
                    {clearDone ? <div className="status online" role="status">✓ 已清空对话历史</div> : null}
                    {managementError}
                  </section>
                ) : null}
              </div>
              {settingsTab ? (
                <BotSettings
                  api={api}
                  botId={bot.botId}
                  botName={bot.role}
                  hostLabel={deviceName}
                  hostPlatform={devicePlatform}
                  tab={settingsTab}
                  open
                  onOpenCenterAdmin={onOpenCenterAdmin}
                  onOpenBrowser={() => setInspectorTab('browser')}
                  callGoogleSetup={callGoogleSetup}
                  onModelSaved={(cfg) => {
                    onBotUpdated({ botId: bot.botId, modelRef: cfg.overrides.modelRef ?? null });
                  }}
                />
              ) : null}
              {inspectorTab === 'raw' ? (
                <RawHistoryPane
                  items={rawItems}
                  loading={online && rawLoading}
                  error={rawError}
                  onLoadMore={() => void loadRaw()}
                  hasMore={false}
                  onRetry={() => void loadRaw()}
                  offline={!online}
                />
              ) : null}
              {inspectorTab === 'shower' ? (
                <ShowerPreview
                  key={sess}
                  variant="desktop"
                  call={callShower}
                  target={{ botId: bot.botId }}
                  connected={api.transportConnected && pageActive}
                  onClose={() => setInspectorTab(null)}
                />
              ) : null}
              {inspectorTab === 'google-setup' && (
                <GoogleSetupWizard
                  key={`google-setup:${sess}:${bot.botId}`}
                  api={api} identity={identity} botId={bot.botId} botName={bot.role}
                  isLocalAndroid={devicePlatform?.toLowerCase() === 'android'}
                  autoStart callGoogleSetup={callGoogleSetup}
                  onOpenBrowser={() => setInspectorTab('browser')}
                  onOpenBrowserDestination={openBrowserDestination}
                  provisionGoogleClient={provisionGoogleClient}
                  onOpenCenterAdmin={() => onOpenCenterAdmin?.('google')}
                  onClose={() => setInspectorTab(null)}
                />
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={browserDialogOpen}
        onOpenChange={(open) => {
          if (!open && inspectorWorkspaceVisibleRef.current) setInspectorTab(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Content
            className="bot-browser-dialog"
            data-browser-overlay="true"
            {...FLOATING_OUTSIDE_GUARD_PROPS}
            onEscapeKeyDown={(event) => {
              const target = event.target;
              if (
                hasOpenFloatingPopover() ||
                (target instanceof Element &&
                  target.closest('.bb-stage--interactive, .bb-remote-input, .ui-popover-menu[data-ui-dialog="open"]'))
              ) {
                event.preventDefault();
              }
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const opener = browserTriggerRef.current;
              browserTriggerRef.current = null;
              if (!inspectorWorkspaceVisibleRef.current) return;
              if (opener?.isConnected) {
                opener.focus();
              } else {
                stageRef.current?.querySelector<HTMLButtonElement>('.chat-header-pill')?.focus();
              }
            }}
          >
            <Dialog.Title className="sr-only">{t(`${bot.role} 的浏览器`, `${bot.role} browser`)}</Dialog.Title>
            <Dialog.Description className="sr-only">
              {t(`查看并控制 Bot「${bot.role}」的内置浏览器会话。`, `View and control the built-in browser session for ${bot.role}.`)}
            </Dialog.Description>
            <BotBrowserPanel
              key={`browser:${sess}:${bot.botId}`}
              botId={bot.botId}
              deviceId={bot.deviceId}
              botName={bot.role}
              mode="sidebar"
              connected={online && pageActive}
              request={callBrowser}
              destination={browserDestination?.scope === browserDestinationScope ? browserDestination.value : undefined}
              onDestinationConsumed={() => setBrowserDestination(null)}
              subscribeFrames={subscribeBrowserFrames}
              nativePresenter={nativeBrowser}
              browserPlacement={nativeBrowser && localBrowser !== nativeBrowser && browserConnectionKind === 'relay' ? {
                value: browserPlacement, canChange: true, set: setBrowserPlacement,
              } : undefined}
              onSwitchToExternalGuide={async (url, reason, rejection) => {
                if (reason === 'google-sign-in-rejected') {
                  if (await continueGoogleSetupAfterSignInRejection(callGoogleSetup, openExternalUrl, rejection)) {
                    setInspectorTab(current => current === 'browser' ? null : current);
                  }
                  return;
                }
                void callGoogleSetup({ action: 'resume', mode: 'guide-browser' }).catch(() => {});
                if (url) await openExternalUrl(url);
              }}
              onClose={() => setInspectorTab(null)}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={confirmArchive && !isArchived && !isPrimary}
        title={t(`归档 Bot「${bot.role}」`, `Archive "${bot.role}"`)}
        description={t(
          `归档「${bot.role}」后，对话转为只读。归档满 ${ARCHIVE_RETENTION_DAYS} 天会自动清理，期间可在已归档 Bot 中恢复。`,
          `Archiving "${bot.role}" makes its chat read-only. It auto-deletes after ${ARCHIVE_RETENTION_DAYS} days and can be restored before then.`,
        )}
        busy={manageBusy}
        disabled={!online}
        error={manageError}
        cancelLabel={t('取消', 'Cancel')}
        confirmLabel={manageAction === 'archive' ? t('正在归档…', 'Archiving…') : t('归档 Bot', 'Archive bot')}
        onCancel={() => {
          if (!manageBusy) {
            setConfirmArchive(false);
            setManageError(null);
          }
        }}
        onConfirm={() => {
          if (!online || manageBusy) return;
          void handleArchive();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const opener = confirmTriggerRef.current;
          confirmTriggerRef.current = null;
          if (!inspectorWorkspaceVisibleRef.current) return;
          if (opener?.isConnected) {
            opener.focus();
          } else if (moreMenuButtonRef.current?.isConnected) {
            moreMenuButtonRef.current.focus();
          } else {
            stageRef.current?.querySelector<HTMLButtonElement>('.chat-header-pill')?.focus();
          }
        }}
      />

      <ConfirmDialog
        open={confirmDelete && !isPrimary}
        title={`永久删除 Bot「${bot.role}」`}
        description={`确定要永久删除 Bot「${bot.role}」吗？删除后该 Bot 的所有对话历史与配置将永久清除，此操作不可撤销。`}
        danger
        busy={manageBusy}
        disabled={!online}
        error={manageError}
        cancelLabel="取消"
        confirmLabel={manageAction === 'delete' ? '删除中…' : '永久删除 Bot'}
        onCancel={() => {
          if (!manageBusy) {
            setConfirmDelete(false);
            setManageError(null);
          }
        }}
        onConfirm={() => {
          if (!online || manageBusy) return;
          void handleDelete();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const opener = confirmTriggerRef.current;
          confirmTriggerRef.current = null;
          if (!inspectorWorkspaceVisibleRef.current) return;
          if (opener?.isConnected) {
            opener.focus();
          } else if (moreMenuButtonRef.current?.isConnected) {
            moreMenuButtonRef.current.focus();
          } else {
            stageRef.current?.querySelector<HTMLButtonElement>('.chat-header-pill')?.focus();
          }
        }}
      />

      <ConfirmDialog
        open={confirmClear && !isArchived}
        title={`清空「${bot.role}」的当前对话`}
        description={`确定要清空 Bot「${bot.role}」的当前对话上下文与历史记录吗？此操作不可撤销。`}
        danger
        busy={manageBusy}
        disabled={!online || slashBusy !== null}
        error={manageError}
        cancelLabel="取消"
        confirmLabel={manageAction === 'clear' ? '清空中…' : '清空当前对话'}
        onCancel={() => {
          if (!manageBusy) {
            setConfirmClear(false);
            setManageError(null);
          }
        }}
        onConfirm={() => {
          if (!online || manageBusy || slashBusy !== null) return;
          void handleClearHistory();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const opener = confirmTriggerRef.current;
          confirmTriggerRef.current = null;
          if (!inspectorWorkspaceVisibleRef.current) return;
          if (opener?.isConnected) {
            opener.focus();
          } else if (moreMenuButtonRef.current?.isConnected) {
            moreMenuButtonRef.current.focus();
          } else {
            stageRef.current?.querySelector<HTMLButtonElement>('.chat-header-pill')?.focus();
          }
        }}
      />
    </div>
  );
}

interface ConfirmDeleteGroupState {
  scopeId: string;
  title: string;
  initialScope: ScopeInfo;
  latestScope: ScopeInfo | null;
  requestId: string;
  loadingLatest: boolean;
  loadError: string | null;
  deleting: boolean;
  deleteError: string | null;
  lockedUnknown: boolean;
}

type ActiveBotChatsModal =
  | { kind: 'createBot'; targetDeviceId: string }
  | { kind: 'createGroup' }
  | { kind: 'archiveBot'; bot: BotDirectoryEntry; archiving: boolean }
  | { kind: 'deleteBot'; bot: BotDirectoryEntry; deleting: boolean; error: string | null }
  | { kind: 'deleteGroup'; state: ConfirmDeleteGroupState };

function isModalBusy(modal: ActiveBotChatsModal | null): boolean {
  if (!modal) return false;
  if (modal.kind === 'archiveBot') return modal.archiving;
  if (modal.kind === 'deleteBot') return modal.deleting;
  if (modal.kind === 'deleteGroup') return modal.state.deleting;
  return false;
}

export function BotChats({
  api,
  currentDeviceId,
  pageActive = true,
  initialBotId,
  initialDeviceId,
  onArchiveBridge,
  boardActive = false,
  tasksActive = false,
  workspaceActive = pageActive,
  centerInterrupted = false,
  onOpenBoardChat,
  onSwitchView,
  onTaskWaitingCountChange,
  onOpenSendRecords,
  onOpenCenterAdmin,
}: {
  api: DesktopPanelApi;
  currentDeviceId: string;
  pageActive?: boolean;
  /** Scopes「打开 Bot」导航：按稳定 botId + deviceId 选中 Bot（同名 Bot 靠 ID 区分）；
   *  initialDeviceId 缺省时只在当前目录中按 botId 匹配。 */
  initialBotId?: string;
  initialDeviceId?: string;
  onArchiveBridge?: (bridge: BotChatsArchiveBridge | null) => void;
  boardActive?: boolean;
  tasksActive?: boolean;
  workspaceActive?: boolean;
  centerInterrupted?: boolean;
  onOpenBoardChat?: () => void;
  onSwitchView?: (next: 'chat' | 'tasks' | 'board') => void;
  onTaskWaitingCountChange?: (count: number) => void;
  onOpenSendRecords?: (target?: SendRecordsTarget) => void;
  onOpenCenterAdmin?: (tab?: CenterAdminTab) => void;
}) {
  const t = useText();
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
  const chatWorkspaceActive = pageActive && workspaceActive && !boardActive && !tasksActive;
  const profileKey = identity ? `${identity.profileId}|${identity.kind}` : '';
  const profileRef = useRef(profileKey);
  const profileReady = profileRef.current === profileKey;
  const initialCache = useMemo(() => readDirectoryCache(profileKey), [profileKey]);
  const lastChat = useMemo(() => readLastChat(profileKey), [profileKey]);
  const restoreRef = useRef({ profileKey: '', restored: false });
  const {
    pinnedKeys,
    isPinned,
    togglePin,
    reorderPins,
    removePin,
    error: pinsError,
  } = useChatPins(profileKey || 'default');

  const [bots, setBots] = useState<DesktopBotDirectoryEntry[]>(() => initialCache?.bots ?? []);
  const readScopes = useRef(new Map<string, BotReadScope>());
  const clearedCutoffsRef = useRef(new Map<string, number>());
  const readScopeFor = useCallback((deviceId: string, botId: string) => {
    const key = JSON.stringify([profileKey, deviceId, botId]);
    let scope = readScopes.current.get(key);
    if (!scope) { scope = new BotReadScope(); readScopes.current.set(key, scope); }
    return scope;
  }, [profileKey]);
  const [devices, setDevices] = useState<DevicesDirectoryItem[]>(() => initialCache?.devices ?? []);
  const boardBots = profileReady ? bots : initialCache?.bots ?? [];
  const boardDevices = profileReady ? devices : initialCache?.devices ?? [];
  const boardTargets: BotBoardTarget[] = identity ? boardBots.filter(bot => !bot.archivedAt).map(bot => {
    const reachable = identity.kind !== 'local' || identity.targetDeviceId === bot.deviceId;
    const targetIdentity = reachable ? api.identityForTarget(bot.deviceId) : identity;
    return {
      key: botBoardKey(profileKey, bot.deviceId, bot.botId),
      hostKey: bot.deviceId,
      generation: sess,
      botId: bot.botId,
      name: bot.role,
      deviceName: boardDevices.find(device => device.deviceId === bot.deviceId)?.displayName || bot.deviceName || '未命名设备',
      avatarKey: botAvatarKey(bot),
      isPrimary: bot.isPrimary,
      online: online && bot.online && reachable,
      read: botIds => api.call(targetIdentity, 'getBotBoard', { botIds }),
    };
  }) : [];
  const board = useBotBoard(boardTargets, pageActive && workspaceActive && boardActive);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<boolean>(() => Boolean(initialCache));
  const [selected, setSelected] = useState<{
    deviceId: string;
    botId: string;
    focusComposer?: boolean;
    questionnaire?: { requestId: string; conversationId: string; session: string };
  } | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveBotChatsModal | null>(null);
  const activeModalRef = useRef<ActiveBotChatsModal | null>(null);
  activeModalRef.current = activeModal;
  const [frozenGroupAttempt, setFrozenGroupAttempt] = useState<FrozenGroupCreateAttempt | null>(null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [deviceFilter, setDeviceFilter] = useState<string>('all');
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
  const [returnTaskId, setReturnTaskId] = useState<string | null>(null);
  const [taskBoardNotice, setTaskBoardNotice] = useState('');
  const [fetchedTasksById, setFetchedTasksById] = useState<Record<string, GlobalTask>>({});
  const taskFetchAttemptedRef = useRef<Set<string>>(new Set());
  const [taskActionFailures, setTaskActionFailures] = useState<Record<string, PendingTaskChatAction>>({});
  const [retryingTaskActionKey, setRetryingTaskActionKey] = useState<string | null>(null);

  const taskScopeKey = profileKey || 'none';
  const taskScopeRef = useRef(taskScopeKey);
  taskScopeRef.current = taskScopeKey;

  const onlineDeviceId = useMemo(() => {
    const current = devices.find((d) => d.deviceId === currentDeviceId && d.online);
    if (current) return current.deviceId;
    const anyOnline = devices.find((d) => d.online);
    if (anyOnline) return anyOnline.deviceId;
    const botDevice = bots.find((b) => b.online)?.deviceId;
    if (botDevice) return botDevice;
    return identity?.kind === 'local' ? identity.targetDeviceId : (devices[0]?.deviceId ?? '');
  }, [devices, bots, currentDeviceId, identity]);

  const taskTransport = useMemo<TaskTransportFn | null>(() => {
    if (!identity) return null;
    const expectedScope = taskScopeKey;
    const ensureCurrentScope = () => {
      if (taskScopeRef.current !== expectedScope) {
        throw new Error('任务作用域已切换');
      }
    };
    return async (input) => {
      ensureCurrentScope();
      try {
        const res = await (api.broker as (id: DesktopIdentity, op: string, params: unknown) => Promise<unknown>)(
          identity,
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
        const fallbackDeviceId =
          identity.kind === 'local'
            ? identity.targetDeviceId
            : onlineDeviceId;
        if (!isUnsupported || !fallbackDeviceId) throw err;
        const targetId = api.identityForTarget(fallbackDeviceId);
        const res = await (api.call as (id: DesktopIdentity, method: string, params: unknown) => Promise<unknown>)(
          targetId,
          'manageTasks',
          input,
        );
        ensureCurrentScope();
        return res;
      }
    };
  }, [api, identity, onlineDeviceId, taskScopeKey]);

  const globalTasks = useGlobalTasks({
    transport: taskTransport,
    enabled: online && pageActive,
    scopeKey: taskScopeKey,
    draftStorageKey: `e-launcher:task-create-draft:v1:${profileKey || 'default'}`,
  });

  const effectiveGlobalTasks = useMemo(() => {
    const existingIds = new Set(globalTasks.tasks.map((item) => item.id));
    const extras = Object.values(fetchedTasksById).filter((item) => !existingIds.has(item.id));
    return extras.length ? [...globalTasks.tasks, ...extras] : globalTasks.tasks;
  }, [globalTasks.tasks, fetchedTasksById]);

  const executeTaskChatAction = useCallback(
    async (action: PendingTaskChatActionInput, options?: { rethrow?: boolean }): Promise<boolean> => {
      const failureKey = `${action.scopeKey}|${action.botKey}`;
      try {
        let updated: GlobalTask;
        if (action.kind === 'answer_prompt') {
          updated = await globalTasks.answerPrompt(action.taskId, action.answer, action.expectedRevision);
        } else if (action.kind === 'confirm_plan') {
          updated = await globalTasks.confirmPlan(action.taskId, action.expectedRevision);
        } else {
          updated = await globalTasks.updateTask(action.payload);
        }
        if (taskScopeRef.current !== action.scopeKey) return false;
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
        if (taskScopeRef.current === action.scopeKey) {
          setTaskActionFailures((prev) => ({
            ...prev,
            [failureKey]: { ...action, error: errText(err) },
          }));
        }
        if (options?.rethrow) throw err;
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

  const onTaskWaitingCountRef = useRef(onTaskWaitingCountChange);
  onTaskWaitingCountRef.current = onTaskWaitingCountChange;
  useEffect(() => {
    onTaskWaitingCountRef.current?.(globalTasks.waitingCount);
  }, [globalTasks.waitingCount]);

  const wasTasksActiveRef = useRef(tasksActive);
  useEffect(() => {
    if (wasTasksActiveRef.current && !tasksActive) {
      if (globalTasks.createDraft.trim()) {
        globalTasks.markDraftLeftUnpublished();
      }
      setCreatingTask(false);
      setTaskInitialEditMode(false);
    }
    wasTasksActiveRef.current = tasksActive;
  }, [tasksActive, globalTasks.createDraft, globalTasks.markDraftLeftUnpublished]);

  const taskBotOptions = useMemo<TaskBotOption[]>(() => {
    return bots
      .filter((b) => !b.archivedAt)
      .map((b) => ({
        deviceId: b.deviceId,
        botId: b.botId,
        name: b.role,
        description: b.description,
        online: Boolean(online && b.online),
        avatar: botAvatarKey(b),
        isPrimary: Boolean(b.isPrimary),
      }));
  }, [bots, online]);
  /** 主舞台内子视图：null = 选中 Bot 的主聊天；dm = 某 Bot 的私聊列表（readOnly）；scope = 群聊详情。
   *  只保存稳定 deviceId/成员/scopeId，不保存 api：profileKey 不含 generation，
   *  冻结的 targetApi 会在同 profile 重连后 identity 永久 null、targetOnline 不随目录更新。 */
  const [stage, setStage] = useState<
    | null
    | { kind: 'dm'; member: MessageMember; name: string; deviceId: string }
    | { kind: 'scope'; scopeId: string; deviceId: string; initialScope?: ScopeInfo | null }
  >(null);
  /** 群聊详情受控设置开关：菜单“查看群详情”以 true 打开，普通点行以 false 打开，切换/退出重置。 */
  const [roomSettingsOpen, setRoomSettingsOpen] = useState(false);
  /** 私聊子视图受控选择：内容 → 列表逐级返回。 */
  const [dmScopeId, setDmScopeId] = useState<string | null>(null);
  const [inspectorRequest, setInspectorRequest] = useState<{
    deviceId: string;
    botId: string;
    tab: InspectorTab;
    seq: number;
  } | null>(null);
  const inspectorSeqRef = useRef(0);
  type HubMenuTarget =
    | { kind: 'bot'; bot: BotDirectoryEntry }
    | { kind: 'group'; group: (typeof groupRows)[number] };
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: HubMenuTarget;
  } | null>(null);
  const [botActionError, setBotActionError] = useState<string | null>(null);
  const [botDeletionNotice, setBotDeletionNotice] = useState('');
  useEffect(() => {
    if (!botDeletionNotice) return;
    const timer = window.setTimeout(() => setBotDeletionNotice(''), 3000);
    return () => window.clearTimeout(timer);
  }, [botDeletionNotice]);
  const archiveFlight = useRef(false);
  const deleteBotFlight = useRef(false);
  const deleteGroupFlight = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const collapseSidebarBtnRef = useRef<HTMLButtonElement | null>(null);
  const chatExpandSidebarBtnRef = useRef<HTMLButtonElement | null>(null);
  const scopeExpandSidebarBtnRef = useRef<HTMLButtonElement | null>(null);
  const emptyExpandSidebarBtnRef = useRef<HTMLButtonElement | null>(null);
  const sidebarFocusRafRef = useRef<number | null>(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;

  useEffect(() => {
    return () => {
      if (sidebarFocusRafRef.current !== null) {
        window.cancelAnimationFrame(sidebarFocusRafRef.current);
        sidebarFocusRafRef.current = null;
      }
    };
  }, []);

  const scheduleSidebarFocus = useCallback((fn: () => void) => {
    if (sidebarFocusRafRef.current !== null) {
      window.cancelAnimationFrame(sidebarFocusRafRef.current);
    }
    sidebarFocusRafRef.current = window.requestAnimationFrame(() => {
      sidebarFocusRafRef.current = null;
      fn();
    });
  }, []);

  const handleCollapseSidebarClick = useCallback(() => {
    setListCollapsed(true);
    scheduleSidebarFocus(() => {
      const target = stageRef.current
        ? scopeExpandSidebarBtnRef.current ?? emptyExpandSidebarBtnRef.current
        : chatExpandSidebarBtnRef.current ?? emptyExpandSidebarBtnRef.current;
      target?.focus();
    });
  }, [scheduleSidebarFocus]);

  const handleExpandSidebarClick = useCallback(() => {
    setListCollapsed(false);
    scheduleSidebarFocus(() => {
      (collapseSidebarBtnRef.current ?? searchInputRef.current)?.focus();
    });
  }, [scheduleSidebarFocus]);

  const openModal = useCallback((next: ActiveBotChatsModal): boolean => {
    if (
      archiveFlight.current ||
      deleteBotFlight.current ||
      deleteGroupFlight.current ||
      isModalBusy(activeModalRef.current)
    ) {
      return false;
    }
    setMenu(null);
    activeModalRef.current = next;
    setActiveModal(next);
    return true;
  }, []);

  const closeModal = useCallback((force = false) => {
    if (
      !force &&
      (archiveFlight.current ||
        deleteBotFlight.current ||
        deleteGroupFlight.current ||
        isModalBusy(activeModalRef.current))
    ) {
      return;
    }
    activeModalRef.current = null;
    setActiveModal(null);
  }, []);

  const updateDeleteGroupModal = useCallback(
    (scopeId: string, updater: (state: ConfirmDeleteGroupState) => ConfirmDeleteGroupState | null) => {
      setActiveModal((cur) => {
        if (cur?.kind !== 'deleteGroup' || cur.state.scopeId !== scopeId) return cur;
        const next = updater(cur.state);
        return next ? { kind: 'deleteGroup', state: next } : null;
      });
    },
    [],
  );

  const openContextMenu = useCallback(
    (position: { x: number; y: number }, target: HubMenuTarget) => {
      if (activeModalRef.current !== null) return;
      setMenu({ ...position, target });
    },
    [],
  );

  // 离开 'chat' 视图（切到任务、看板、设置、发送记录或中心管理）时清理瞬态弹窗与上下文菜单，避免回切后旧弹窗复活。
  useEffect(() => {
    if (!chatWorkspaceActive) {
      activeModalRef.current = null;
      setActiveModal(null);
      setMenu(null);
    }
  }, [chatWorkspaceActive]);
  const refreshQueued = useRef(false);
  const inFlight = useRef(false);
  const seq = useRef(0);
  const sessionRef = useRef(sess);
  sessionRef.current = sess;
  const lastLiveRefreshRef = useRef(0);
  const onQuestionnaireFocused = useCallback((id: string) => {
    setSelected(current => current?.questionnaire?.requestId === id && current.questionnaire.session === sess
      ? { ...current, questionnaire: undefined }
      : current);
  }, [sess]);

  useEffect(() => {
    setSelected(current => current?.questionnaire && (stage || current.questionnaire.session !== sess)
      ? { ...current, questionnaire: undefined }
      : current);
  }, [stage, sess]);

  const loadBots = useCallback(async () => {
    if (!identity || !api.transportConnected || !pageActive || !visible || inFlight.current) return;
    const localSess = sess;
    const localProfileKey = profileKey;
    const n = ++seq.current;
    inFlight.current = true;
    setLoading(true);
    try {
      const directory = await api.broker(identity, 'bot_directory', {});
      if (seq.current !== n || sessionRef.current !== localSess) return;
      await syncBotAvatarConfigs(api, directory.bots, currentDeviceId);
      if (seq.current !== n || sessionRef.current !== localSess) return;
      const unavailable = new Set(directory.devices.filter((d) => !d.online).map((d) => d.deviceId));
      for (const error of directory.errors) unavailable.add(error.deviceId);
      setBots((old) => {
        const merged = [
          ...directory.bots,
          ...old
            .filter(
              (b) =>
                (unavailable.has(b.deviceId) ||
                  !directory.devices.some((d) => d.deviceId === b.deviceId)) &&
                !directory.bots.some(
                  (next) => next.deviceId === b.deviceId && next.botId === b.botId,
                ),
            )
            .map((b) => ({ ...b, online: false })),
        ];
        writeDirectoryCache(localProfileKey, merged, directory.devices);
        return merged;
      });
      setDevices(directory.devices);
      setLoaded(true);
      const actionableErrors = directory.errors.filter(
        (e) => e.code !== 'OFFLINE' && e.code !== 'CONTROL_UNAVAILABLE' && e.code !== 'DISCONNECTED',
      );
      setBotsError(
        actionableErrors.length
          ? actionableErrors
              .map((e) => {
                const devName = directory.devices.find((d) => d.deviceId === e.deviceId)?.displayName || e.deviceId;
                return `${devName}: ${errText(e)}`;
              })
              .join('；')
          : null,
      );
    } catch (e) {
      if (seq.current === n && sessionRef.current === localSess) {
        setBotsError(`目录读取失败：${errText(e)}`);
        // 整体目录失败：旧缓存不得继续冒充在线，绿点全部熄灭；下次成功刷新自然恢复。
        setBots((old) => old.map((b) => ({ ...b, online: false })));
        setDevices((old) => old.map((d) => ({ ...d, online: false })));
      }
    } finally {
      inFlight.current = false;
      if (seq.current === n && sessionRef.current === localSess) setLoading(false);
      if (refreshQueued.current) {
        refreshQueued.current = false;
        setRefreshVersion((v) => v + 1);
      }
    }
  }, [api, sess, profileKey, online, pageActive, visible, currentDeviceId]);

  const triggerLoadBots = useCallback(() => {
    if (inFlight.current) {
      refreshQueued.current = true;
    } else {
      void loadBots();
    }
  }, [loadBots]);

  const handleLiveActivity = useCallback(() => {
    const now = Date.now();
    if (now - lastLiveRefreshRef.current < 400) {
      refreshQueued.current = true;
      return;
    }
    lastLiveRefreshRef.current = now;
    triggerLoadBots();
  }, [triggerLoadBots]);

  useEffect(() => {
    if (loaded && profileKey && profileRef.current === profileKey) {
      writeDirectoryCache(profileKey, bots, devices);
    }
  }, [loaded, profileKey, bots, devices]);

  useEffect(() => {
    const onVisibility = () => {
      const nextVisible = !document.hidden;
      setVisible(nextVisible);
      if (nextVisible) triggerLoadBots();
    };
    const onFocus = () => {
      const nextVisible = !document.hidden;
      setVisible(nextVisible);
      if (nextVisible) triggerLoadBots();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [triggerLoadBots]);

  useEffect(() => {
    if (profileRef.current !== profileKey) {
      profileRef.current = profileKey;
      restoreRef.current = { profileKey, restored: false };
      const cached = readDirectoryCache(profileKey);
      setBots(cached?.bots ?? []);
      setDevices(cached?.devices ?? []);
      setSelected(null);
      setLoaded(Boolean(cached));
      setBotsError(null);
      // 仅真实换 profile/kind 才放弃子视图/菜单/受控 DM 选择；同 profile 重连
      // （新 generation）由 stageApi 随 sess 重建接续，普通刷新与可见性变化保留。
      setStage(null);
      setRoomSettingsOpen(false);
      setMenu(null);
      setDmScopeId(null);
      setBotActionError(null);
      activeModalRef.current = null;
      setActiveModal(null);
      setInspectorRequest(null);
      setFrozenGroupAttempt(null);
      setDeviceFilter('all');
      setQuery('');
      setActiveTaskId(null);
      setCreatingTask(false);
      setTaskInitialEditMode(false);
      setJumpedTaskQuote(null);
      setWaitingTaskOffsetByBot({});
      setReturnTaskId(null);
      setTaskBoardNotice('');
      setFetchedTasksById({});
      taskFetchAttemptedRef.current.clear();
      setTaskActionFailures({});
      setRetryingTaskActionKey(null);
    }
    seq.current += 1;
    setLoading(false);
    if (online && pageActive && visible) void loadBots();
    const timer =
      online && pageActive && visible
        ? window.setInterval(() => void loadBots(), DIRECTORY_POLL_INTERVAL_MS)
        : null;
    return () => {
      seq.current += 1;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [loadBots, profileKey, online, pageActive, visible, refreshVersion]);

  // Ctrl/Cmd+K 聚焦搜索 · Ctrl/Cmd+B 折叠列表 · Ctrl/Cmd+F 会话内搜索 · Ctrl/Cmd+. 工作台
  // 严格限定在对话工作台生效：任务/看板/模态弹窗/全屏浏览器或桌面/图片灯箱/输入焦点中不消费。
  const shortcutStateRef = useRef({ canChatShortcut: false, modalOpen: false });
  useEffect(() => {
    if (!chatWorkspaceActive) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
      if (shortcutStateRef.current.modalOpen || activeModalRef.current !== null || hasBlockingWorkbenchOverlay()) return;
      if (isEditableKeyboardTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        setListCollapsed(false);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if (k === 'b') {
        e.preventDefault();
        setListCollapsed((v) => !v);
      } else if (k === 'f' && shortcutStateRef.current.canChatShortcut) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('botchats:chat-search'));
      } else if (e.key === '.' && shortcutStateRef.current.canChatShortcut) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('botchats:toggle-inspector'));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatWorkspaceActive]);

  const missingPrimaryDevices = useMemo(
    () =>
      devices.filter(
        (d) =>
          d.deviceId === currentDeviceId && d.online &&
          !bots.some((b) => b.deviceId === d.deviceId && b.isPrimary && !b.archivedAt),
      ),
    [devices, bots, currentDeviceId],
  );

  const filteredBots = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bots.filter((b) => {
      if (deviceFilter !== 'all' && b.deviceId !== deviceFilter) return false;
      if (!q) return true;
      const hay = `${b.role} ${b.description} ${b.botId} ${b.deviceId} ${b.lastPreview ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [bots, query, deviceFilter]);

  const { primaryBots, regularBots } = useMemo(() => {
    const sortByRecent = (a: BotDirectoryEntry, b: BotDirectoryEntry) =>
      botSortTimestamp(b) - botSortTimestamp(a);
    const primary = filteredBots
      .filter((b) => !b.archivedAt && b.isPrimary && b.deviceId === currentDeviceId)
      .slice()
      .sort(sortByRecent);
    const regular = filteredBots
      .filter((b) => !b.archivedAt && !(b.isPrimary && b.deviceId === currentDeviceId))
      .slice()
      .sort(sortByRecent);
    return { primaryBots: primary, regularBots: regular };
  }, [filteredBots, currentDeviceId]);

  const allArchivedBots = useMemo(() => {
    const sortByRecent = (a: BotDirectoryEntry, b: BotDirectoryEntry) =>
      botSortTimestamp(b) - botSortTimestamp(a);
    return bots
      .filter((b) => Boolean(b.archivedAt))
      .slice()
      .sort(sortByRecent);
  }, [bots]);

  // 群聊行只读来源：只枚举真实有 Bot 的 Host 设备（目录可能含无 Bot 的 center 节点，
  // 对其调用 listScopeStates 会报错）；冻结 targetApi + identityForTarget，离线目标自然不可写。
  const scopeSources = useMemo(() => {
    if (!identity || !profileReady) return [];
    const onlineByDevice = new Map(devices.map((d) => [d.deviceId, d.online]));
    const nameByDevice = new Map(devices.map((d) => [d.deviceId, d.displayName || '未命名设备']));
    const hostDeviceIds = [...new Set(bots.map((b) => b.deviceId))]
      .filter(deviceId => identity.kind !== 'local' || deviceId === identity.targetDeviceId);
    return hostDeviceIds.map((deviceId) => ({
      key: deviceId,
      label: nameByDevice.get(deviceId) ?? deviceId,
      api: targetApi(api, deviceId, onlineByDevice.get(deviceId) ?? false),
      identity: api.identityForTarget(deviceId),
      bots,
    }));
  }, [api, identity, sess, profileReady, devices, bots]);
  const {
    items: groupItems,
    loading: groupsLoading,
    loaded: groupsLoaded,
    error: groupsError,
    refresh: refreshGroups,
    markDeleted: markGroupDeleted,
  } = useScopeConversations(scopeSources, pageActive && !boardActive, 'room');
  const hasOnlineGroupSource = scopeSources.some(source => source.api.transportConnected);

  useEffect(() => {
    if (!profileKey || !profileReady || !workspaceActive || boardActive || !loaded || initialBotId) return;
    if (restoreRef.current.profileKey !== profileKey) {
      restoreRef.current = { profileKey, restored: false };
    }
    const restore = restoreRef.current;
    if (restore.restored) return;
    if (selected || stage) {
      restore.restored = true;
      return;
    }
    if (lastChat?.kind === 'scope') {
      const group = groupItems.find(item => item.scope.scope.scopeId === lastChat.id &&
        item.identity.profileId === identity?.profileId && item.identity.kind === identity?.kind);
      if (group) {
        restore.restored = true;
        setStage({ kind: 'scope', scopeId: lastChat.id, deviceId: group.identity.targetDeviceId });
        return;
      }
      if (!online || (hasOnlineGroupSource && (!groupsLoaded || groupsLoading || groupsError))) return;
    }
    const savedBot = lastChat?.kind === 'bot' && (identity?.kind !== 'local' || identity.targetDeviceId === lastChat.deviceId)
      ? bots.find(bot => bot.botId === lastChat.id && bot.deviceId === lastChat.deviceId && !bot.archivedAt)
      : undefined;
    const onlinePrimary = (bot: BotDirectoryEntry) => online && bot.online && bot.isPrimary && !bot.archivedAt;
    const bot = savedBot ?? bots.find(bot => onlinePrimary(bot) && bot.deviceId === currentDeviceId) ?? bots.find(onlinePrimary);
    if (!bot) return;
    restore.restored = true;
    setSelected({ deviceId: bot.deviceId, botId: bot.botId, focusComposer: true });
  }, [profileKey, profileReady, identity, workspaceActive, boardActive, loaded, initialBotId, selected,
    stage, lastChat, groupItems, groupsLoaded, groupsLoading, groupsError, online, hasOnlineGroupSource, bots, currentDeviceId]);

  useEffect(() => {
    if (!profileKey || !profileReady) return;
    let selection: LastChat | undefined;
    if (stage?.kind === 'scope' && groupItems.some(item => item.scope.scope.scopeId === stage.scopeId &&
        item.identity.profileId === identity?.profileId && item.identity.kind === identity?.kind)) {
      selection = { kind: 'scope', deviceId: stage.deviceId, id: stage.scopeId };
    } else if (!stage && selected && bots.some(bot => bot.deviceId === selected.deviceId &&
        bot.botId === selected.botId && !bot.archivedAt)) {
      selection = { kind: 'bot', deviceId: selected.deviceId, id: selected.botId };
    }
    if (!selection) return;
    try {
      const key = `desktop-last-chat:v1:${profileKey}`;
      const value = JSON.stringify(selection);
      if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
    } catch {
      // 连接仍可使用当前选中的会话。
    }
  }, [profileKey, profileReady, identity, stage, selected, bots, groupItems]);

  const groupRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groupItems.filter((g) => {
      // 设备筛选按 scope 成员涉及的真实 deviceId（同一 scopeId 跨设备副本都能命中）。
      if (
        deviceFilter !== 'all' &&
        !g.scope.scope.members.some((m) => m.deviceId === deviceFilter)
      ) {
        return false;
      }
      if (!q) return true;
      return `${g.title} ${g.lastPreview} ${g.scope.scope.scopeId}`
        .toLowerCase()
        .includes(q);
    });
  }, [groupItems, query, deviceFilter]);

  type HubMixedRow =
    | { kind: 'bot'; chatKey: string; bot: BotDirectoryEntry; ts: number; pinned: boolean }
    | { kind: 'group'; chatKey: string; group: (typeof groupRows)[number]; ts: number; pinned: boolean };

  // 置顶项按 pinnedKeys 固定顺序排在上方（不随消息时间变）；未置顶项按最近活动时间排序。
  // 仅当前设备 Hero 主 Bot 不可置顶；下方列表中的远端主 Bot 也支持置顶与混排。
  const { pinnedRows, unpinnedRows, visiblePinnedKeys } = useMemo(() => {
    const pinnedByKey = new Map<string, HubMixedRow>();
    const unpinned: HubMixedRow[] = [];
    for (const bot of regularBots) {
      const chatKey = botPinKey(bot.deviceId, bot.botId);
      const canPin = !(bot.isPrimary && bot.deviceId === currentDeviceId) && !bot.archivedAt;
      const pinned = canPin && isPinned(chatKey);
      const row: HubMixedRow = {
        kind: 'bot',
        chatKey,
        bot,
        ts: botSortTimestamp(bot),
        pinned,
      };
      if (pinned) pinnedByKey.set(chatKey, row);
      else unpinned.push(row);
    }
    for (const group of groupRows) {
      const chatKey = roomPinKey(group.scope.scope.scopeId);
      const pinned = isPinned(chatKey);
      const ts = group.lastActivityAt ? Date.parse(group.lastActivityAt) || 0 : 0;
      const row: HubMixedRow = {
        kind: 'group',
        chatKey,
        group,
        ts,
        pinned,
      };
      if (pinned) pinnedByKey.set(chatKey, row);
      else unpinned.push(row);
    }
    const pinnedList: HubMixedRow[] = [];
    for (const key of pinnedKeys) {
      const matched = pinnedByKey.get(key);
      if (matched) pinnedList.push(matched);
    }
    unpinned.sort((a, b) => b.ts - a.ts);
    return {
      pinnedRows: pinnedList,
      unpinnedRows: unpinned,
      visiblePinnedKeys: pinnedList.map((r) => r.chatKey),
    };
  }, [regularBots, groupRows, pinnedKeys, isPinned, currentDeviceId]);

  const mixedRows = useMemo(
    () => [...pinnedRows, ...unpinnedRows],
    [pinnedRows, unpinnedRows],
  );

  // 搜索或设备筛选激活时，仅替换可见置顶项在 pinnedKeys 中的相对槽位，不丢失不可见置顶项。
  const handleReorderPinned = useCallback(
    (nextVisibleKeys: string[]) => {
      const visibleSet = new Set(nextVisibleKeys);
      let idx = 0;
      const merged = pinnedKeys.map((k) =>
        visibleSet.has(k) ? (nextVisibleKeys[idx++] ?? k) : k,
      );
      reorderPins(merged);
    },
    [pinnedKeys, reorderPins],
  );

  const selectedBot = profileReady && selected
    ? bots.find((b) => b.deviceId === selected.deviceId && b.botId === selected.botId) ?? null
    : null;
  const scopedApi = useMemo(
    () =>
      identity && selectedBot && (identity.kind !== 'local' || identity.targetDeviceId === selectedBot.deviceId)
        ? targetApi(api, selectedBot.deviceId, selectedBot.online)
        : null,
    [api, sess, selectedBot?.deviceId, selectedBot?.online],
  );
  const unreadRows = useMemo(() => [
    ...bots.filter(bot => !bot.archivedAt).map(bot => ({
      key: botPinKey(bot.deviceId, bot.botId),
      lastMessageAt: bot.lastPreview?.trim() ? bot.lastActivityAt : null,
    })),
    ...groupItems.map(group => ({
      key: roomPinKey(group.scope.scope.scopeId),
      lastMessageAt: group.lastActivityAt,
    })),
  ], [bots, groupItems]);
  const viewingBotKey = chatWorkspaceActive && !stage && scopedApi && selectedBot && !selectedBot.archivedAt
    ? botPinKey(selectedBot.deviceId, selectedBot.botId)
    : null;
  const { unread, markViewed } = useConversationUnread(
    profileReady && profileKey ? profileKey : null,
    unreadRows,
    viewingBotKey,
  );
  const onRoomHistoryViewed = useCallback((scopeId: string, lastMessageAt: string) => {
    markViewed(roomPinKey(scopeId), lastMessageAt);
  }, [markViewed]);
  /** 子视图 api 按当前 api + sess（含 generation）+ 在线布尔重建：同 profile 重连后
   *  identity 代际更新、设备上下线同步反映；不依赖 devices 数组引用（每轮目录刷新
   *  都换引用，依赖它会反复给 Scopes 传新 api 对象导致历史清空/重置）。 */
  const stageOnline = stage ? deviceOnlineOf(stage.deviceId) : false;
  const stageApi = useMemo(
    () => (identity && profileReady && stage && (identity.kind !== 'local' || identity.targetDeviceId === stage.deviceId)
      ? targetApi(api, stage.deviceId, stageOnline) : null),
    [api, identity, profileReady, sess, stage?.deviceId, stageOnline],
  );
  // Scopes 目录：bots 已含远端与归档记录，透传 deviceName/hostLabel/platform/description，
  // 跨设备群成员与 DM 成员/作者名均显示自然设备名，不回退 UUID。
  const scopeDeviceMetaSig = devices
    .map((d) => `${d.deviceId}\u0001${d.displayName ?? ''}\u0001${d.platform ?? ''}`)
    .join('\u0002');
  const scopeKnownBots = useMemo(() => {
    const devById = new Map(devices.map((d) => [d.deviceId, d]));
    return bots.map((b) => {
      const dev = devById.get(b.deviceId);
      const deviceName = dev?.displayName || b.deviceName;
      const platform = dev?.platform ?? b.platform;
      return {
        deviceId: b.deviceId,
        botId: b.botId,
        role: b.role,
        isPrimary: Boolean(b.isPrimary),
        deviceName,
        hostLabel: deviceName,
        platform,
        description: b.description,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, scopeDeviceMetaSig]);
  // 群成员编辑候选只收未归档 Bot；knownBots 仍含归档用于名字解析。
  const scopeMemberCandidates = useMemo(() => {
    const devById = new Map(devices.map((d) => [d.deviceId, d]));
    return bots
      .filter((b) => !b.archivedAt)
      .map((b) => {
        const dev = devById.get(b.deviceId);
        const deviceName = dev?.displayName || b.deviceName;
        const platform = dev?.platform ?? b.platform;
        return {
          deviceId: b.deviceId,
          botId: b.botId,
          role: b.role,
          isPrimary: Boolean(b.isPrimary),
          deviceName,
          hostLabel: deviceName,
          platform,
          description: b.description,
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, scopeDeviceMetaSig]);
  /**
   * 群聊写端路由：复用当前全局 api（同一份 pending/草稿账本），targetApi 冻结到目标设备。
   * 成员变更只打 scope.authorityDeviceId（null 不伪造目标）；发送打当前成员所在 Host ——
   * 本机成员优先，其次在线 authority 成员、其他在线成员，全离线保留稳定成员目标供排队。
   * 本机群聊走现有 local/relay 完整 api 回环本机；local profile 的 identityForTarget
   * 不能跨设备（api.ts 会抛），relay 目标缺失的设备目录项返回 null 显示待连接。
   */
  // 设备目录每轮轮询换引用：写端映射与发送路由都按「设备+在线布尔」内容签名
  // 重建，同内容刷新不给 Scopes 换 resolver/api 引用（避免 detail 重置）。
  const roomDevicesSig = devices
    .map((d) => d.deviceId + '\u0001' + Boolean(d.online))
    .join('\u0002');
  const roomWriteTargetApiMap = useMemo(() => {
    const onlineByDevice = new Map(devices.map((d) => [d.deviceId, d.online]));
    const map = new Map<string, DesktopPanelApi>();
    for (const d of devices) {
      try {
        map.set(d.deviceId, targetApi(api, d.deviceId, onlineByDevice.get(d.deviceId) ?? false));
      } catch {
        // identityForTarget 跨设备被拒（local profile 指向其他设备）：该设备无写端。
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sess, roomDevicesSig]);
  const roomSendDeviceIdOf = useCallback(
    (scope: ScopeInfo): string => {
      const memberDevices = scope.scope.members.map((m) => m.deviceId);
      if (memberDevices.includes(currentDeviceId) && deviceOnlineOf(currentDeviceId)) return currentDeviceId;
      const authority = scope.authorityDeviceId;
      if (authority && memberDevices.includes(authority) && deviceOnlineOf(authority)) return authority;
      const onlineMember = memberDevices.find((id) => deviceOnlineOf(id));
      if (onlineMember) return onlineMember;
      if (authority && memberDevices.includes(authority)) return authority;
      return memberDevices[0] ?? '';
    },
    // 在线布尔已含在 roomDevicesSig；目录同内容刷新不换 resolver 引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentDeviceId, roomDevicesSig],
  );
  const resolveRoomApi = useCallback<RoomApiResolver>(
    (scope, purpose) => {
      const target = purpose === 'members' ? scope.authorityDeviceId : roomSendDeviceIdOf(scope);
      if (!target) return null;
      return roomWriteTargetApiMap.get(target) ?? null;
    },
    [roomSendDeviceIdOf, roomWriteTargetApiMap],
  );
  /**
   * DM 成员只读端解析器：优先命中按「设备+在线布尔」内容签名稳定的 roomWriteTargetApiMap，
   * 目录尚未含目标设备时回退 stageApi（仅 targetDeviceId 精确匹配）。
   * 同内容目录轮询不换引用，避免 DM 详情重置成员观察与历史。
   */
  const resolveMemberApi = useCallback<MemberApiResolver>(
    (deviceId) => {
      if (!deviceId) return null;
      const mapped = roomWriteTargetApiMap.get(deviceId);
      if (mapped) return mapped;
      return stageApi?.identity?.targetDeviceId === deviceId ? stageApi : null;
    },
    [roomWriteTargetApiMap, stageApi],
  );
  // Scopes 消息链接与主聊同一通道：desktop_open_center 原生命令（仅放行 HTTPS），失败可见化。
  const openScopeLink = useCallback(
    (href: string) =>
      invoke('desktop_open_center', { url: href }).catch((e: unknown) => {
        setBotsError(e instanceof Error ? e.message : String(e));
      }),
    [],
  );
  const selectedDeviceName = selectedBot
    ? devices.find((d) => d.deviceId === selectedBot.deviceId)?.displayName ||
      selectedBot.deviceName ||
      '未命名设备'
    : '';
  const selectedDevicePlatform = selectedBot
    ? devices.find((d) => d.deviceId === selectedBot.deviceId)?.platform ?? selectedBot.platform
    : undefined;

  const selectedBotJumpedTaskId =
    selectedBot &&
    jumpedTaskQuote &&
    jumpedTaskQuote.deviceId === selectedBot.deviceId &&
    jumpedTaskQuote.botId === selectedBot.botId
      ? jumpedTaskQuote.taskId
      : null;

  useEffect(() => {
    if (!online || !pageActive || !taskTransport) return;
    const candidateIds = [selectedBotJumpedTaskId, returnTaskId].filter((id): id is string => Boolean(id));
    for (const tid of candidateIds) {
      if (globalTasks.tasks.some((item) => item.id === tid)) continue;
      if (fetchedTasksById[tid]) continue;
      const attemptKey = `${taskScopeKey}|${tid}`;
      if (taskFetchAttemptedRef.current.has(attemptKey)) continue;
      taskFetchAttemptedRef.current.add(attemptKey);
      const capturedScope = taskScopeKey;
      void globalTasks
        .getTask(tid)
        .then((fetched) => {
          if (taskScopeRef.current !== capturedScope || !fetched) return;
          setFetchedTasksById((prev) => ({ ...prev, [fetched.id]: fetched }));
        })
        .catch(() => {
          // 列表截断补充查询失败时保留静态回退，不阻塞聊天主流程。
        });
    }
  }, [online, pageActive, taskTransport, selectedBotJumpedTaskId, returnTaskId, globalTasks, fetchedTasksById, taskScopeKey]);

  const onlineDevices = useMemo(() => devices.filter((d) => d.online), [devices]);

  // Scopes onOpenBot → initialBotId/initialDeviceId：目录到达后按稳定 ID 选中 Bot，
  // 并切到该 Bot 所在设备筛选；同 botId 跨设备时以 deviceId 为准（身份可核对）。
  const initialNavRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialBotId || !profileReady) {
      initialNavRef.current = null;
      return;
    }
    const key = `${profileKey}:${initialDeviceId ?? ''}:${initialBotId}`;
    if (initialNavRef.current === key) return;
    const target = bots.find(
      (b) =>
        b.botId === initialBotId &&
        (initialDeviceId === undefined || b.deviceId === initialDeviceId),
    );
    if (!target) return;
    initialNavRef.current = key;
    setDeviceFilter(target.deviceId);
    setSelected({ deviceId: target.deviceId, botId: target.botId });
    setRoomSettingsOpen(false);
    setStage(null);
  }, [initialBotId, initialDeviceId, profileReady, profileKey, bots]);

  const archiveBotEntry = useCallback(
    async (targetBot: BotDirectoryEntry) => {
      if (!identity || !api.transportConnected || targetBot.isPrimary || targetBot.archivedAt) return;
      const localSess = sessionRef.current;
      setBotActionError(null);
      try {
        const botApi = targetApi(api, targetBot.deviceId, Boolean(targetBot.online && api.transportConnected));
        if (!botApi.identity || !botApi.transportConnected) {
          throw new Error('目标设备离线或未连接');
        }
        const updated = await botApi.call(botApi.identity, 'archiveBot', { botId: targetBot.botId });
        if (sessionRef.current !== localSess) return;
        const archivedAt =
          updated &&
          typeof updated === 'object' &&
          'archivedAt' in updated &&
          typeof (updated as { archivedAt?: unknown }).archivedAt === 'string'
            ? (updated as { archivedAt: string }).archivedAt
            : new Date().toISOString();
        removePin(botPinKey(targetBot.deviceId, targetBot.botId));
        setBots((old) =>
          old.map((b) =>
            b.deviceId === targetBot.deviceId && b.botId === targetBot.botId
              ? {
                  ...b,
                  ...(updated && typeof updated === 'object' ? (updated as Partial<BotRecord>) : {}),
                  archivedAt,
                  isPrimary: false,
                }
              : b,
          ),
        );
        triggerLoadBots();
      } catch (e) {
        if (sessionRef.current === localSess) {
          setBotActionError(`归档「${targetBot.role}」失败：${errText(e)}`);
          reportUnlessTargetOffline(api, e);
        }
        throw e;
      }
    },
    [api, identity, removePin, triggerLoadBots],
  );

  const unarchiveBotEntry = useCallback(
    async (targetBot: BotDirectoryEntry) => {
      if (!identity || !api.transportConnected || !targetBot.archivedAt) return;
      const localSess = sessionRef.current;
      setBotActionError(null);
      try {
        const botApi = targetApi(api, targetBot.deviceId, Boolean(targetBot.online && api.transportConnected));
        if (!botApi.identity || !botApi.transportConnected) {
          throw new Error('目标设备离线或未连接');
        }
        const updated = await botApi.call(botApi.identity, 'unarchiveBot', { botId: targetBot.botId });
        if (sessionRef.current !== localSess) return;
        setBots((old) =>
          old.map((b) =>
            b.deviceId === targetBot.deviceId && b.botId === targetBot.botId
              ? {
                  ...b,
                  ...(updated && typeof updated === 'object' ? (updated as Partial<BotRecord>) : {}),
                  archivedAt: null,
                }
              : b,
          ),
        );
        triggerLoadBots();
      } catch (e) {
        if (sessionRef.current === localSess) {
          setBotActionError(`恢复「${targetBot.role}」失败：${errText(e)}`);
          reportUnlessTargetOffline(api, e);
        }
        throw e;
      }
    },
    [api, identity, triggerLoadBots],
  );

  const deleteBotEntry = useCallback(
    async (targetBot: BotDirectoryEntry) => {
      if (!identity || !api.transportConnected) {
        throw new Error(t('连接已断开，无法删除已归档智能体', 'Disconnected; unable to delete archived bot'));
      }
      if (targetBot.isPrimary) {
        throw new Error(t('主智能体不可删除，请先将其他智能体设为主智能体', 'Primary bot cannot be deleted; set another bot as primary first'));
      }
      const localSess = sessionRef.current;
      setBotActionError(null);
      const scope = readScopeFor(targetBot.deviceId, targetBot.botId);
      scope.suspend();
      let deleted = false;
      try {
        const botApi = targetApi(api, targetBot.deviceId, Boolean(targetBot.online && api.transportConnected));
        if (!botApi.identity || !botApi.transportConnected) {
          throw new Error('目标设备离线或未连接');
        }
        const targetIdentity = botApi.identity;
        await deleteBotAndVerify(
          () => botApi.call(targetIdentity, 'deleteBot', { botId: targetBot.botId }),
          () => botApi.call(targetIdentity, 'getBot', { botId: targetBot.botId }),
        );
        deleted = true;
        if (sessionRef.current !== localSess) return;
        seq.current += 1;
        removePin(botPinKey(targetBot.deviceId, targetBot.botId));
        setSelected((cur) =>
          cur && cur.deviceId === targetBot.deviceId && cur.botId === targetBot.botId ? null : cur,
        );
        setStage((cur) =>
          cur &&
          cur.kind === 'dm' &&
          cur.member.deviceId === targetBot.deviceId &&
          cur.member.botId === targetBot.botId
            ? null
            : cur,
        );
        setBots((old) =>
          old.filter((b) => !(b.deviceId === targetBot.deviceId && b.botId === targetBot.botId)),
        );
        setBotDeletionNotice(`「${targetBot.role}」已删除`);
        triggerLoadBots();
        refreshGroups();
      } finally {
        if (!deleted) scope.resume();
      }
    },
    [api, identity, removePin, triggerLoadBots, refreshGroups, readScopeFor, t],
  );

  const openArchivedBotHistory = useCallback((targetBot: BotDirectoryEntry) => {
    setDeviceFilter('all');
    setQuery('');
    setRoomSettingsOpen(false);
    setStage(null);
    setSelected({ deviceId: targetBot.deviceId, botId: targetBot.botId });
  }, []);

  const conversationName = useCallback((target: SendRecordsTarget): string | undefined => {
    if (!identity || !profileReady) return undefined;
    if (identity.kind === 'local' && identity.targetDeviceId !== target.deviceId) return undefined;
    if (target.botId) return bots.find(bot => bot.botId === target.botId && bot.deviceId === target.deviceId)?.role;
    return groupItems.find(group => group.scope.scope.scopeId === target.scopeId &&
      group.identity.profileId === identity.profileId && group.identity.kind === identity.kind)?.title;
  }, [identity, profileReady, bots, groupItems]);

  const openConversation = useCallback((target: SendRecordsTarget, panel?: 'profile' | 'google-setup') => {
    if (!conversationName(target)) return;
    activeModalRef.current = null;
    setActiveModal(null);
    setMenu(null);
    setReturnTaskId(null);
    setJumpedTaskQuote(null);
    if (panel && target.botId) {
      setInspectorRequest({
        deviceId: target.deviceId,
        botId: target.botId,
        tab: panel,
        seq: ++inspectorSeqRef.current,
      });
    } else {
      setInspectorRequest(null);
    }
    setDeviceFilter('all');
    setQuery('');
    setRoomSettingsOpen(false);
    if (target.botId) {
      setSelected({ deviceId: target.deviceId, botId: target.botId });
      setStage(null);
    } else if (target.scopeId) {
      const group = groupItems.find(item => item.scope.scope.scopeId === target.scopeId &&
        item.identity.profileId === identity?.profileId && item.identity.kind === identity?.kind);
      if (group) setStage({ kind: 'scope', scopeId: target.scopeId, deviceId: group.identity.targetDeviceId });
    }
  }, [conversationName, groupItems, identity]);

  const archiveBridge = useMemo<BotChatsArchiveBridge>(
    () => ({
      archivedBots: allArchivedBots,
      devices,
      online,
      loading,
      error: botsError,
      refresh: triggerLoadBots,
      openBotHistory: openArchivedBotHistory,
      unarchiveBot: unarchiveBotEntry,
      deleteBot: deleteBotEntry,
      conversationName,
      openConversation,
    }),
    [
      allArchivedBots,
      devices,
      online,
      loading,
      botsError,
      triggerLoadBots,
      openArchivedBotHistory,
      unarchiveBotEntry,
      deleteBotEntry,
      conversationName,
      openConversation,
    ],
  );

  useEffect(() => {
    onArchiveBridge?.(profileReady ? archiveBridge : null);
  }, [onArchiveBridge, archiveBridge, profileReady]);

  useEffect(() => {
    return () => {
      onArchiveBridge?.(null);
    };
  }, [onArchiveBridge]);

  async function handleConfirmDeleteBot() {
    if (activeModal?.kind !== 'deleteBot' || activeModal.deleting || deleteBotFlight.current) return;
    const targetBot = activeModal.bot;
    deleteBotFlight.current = true;
    setActiveModal((cur) =>
      cur?.kind === 'deleteBot' && cur.bot.deviceId === targetBot.deviceId && cur.bot.botId === targetBot.botId
        ? { ...cur, deleting: true, error: null }
        : cur,
    );
    try {
      await deleteBotEntry(targetBot);
      setActiveModal((cur) =>
        cur?.kind === 'deleteBot' && cur.bot.deviceId === targetBot.deviceId && cur.bot.botId === targetBot.botId
          ? null
          : cur,
      );
    } catch (e) {
      setActiveModal((cur) =>
        cur?.kind === 'deleteBot' && cur.bot.deviceId === targetBot.deviceId && cur.bot.botId === targetBot.botId
          ? { ...cur, deleting: false, error: t('永久删除失败：', 'Permanent deletion failed: ') + errText(e) }
          : cur,
      );
    } finally {
      deleteBotFlight.current = false;
    }
  }

  async function handleConfirmArchive() {
    if (activeModal?.kind !== 'archiveBot' || !online || archiveFlight.current) return;
    const targetBot = activeModal.bot;
    const session = sessionRef.current;
    archiveFlight.current = true;
    setActiveModal((cur) =>
      cur?.kind === 'archiveBot' && cur.bot.deviceId === targetBot.deviceId && cur.bot.botId === targetBot.botId
        ? { ...cur, archiving: true }
        : cur,
    );
    try {
      await archiveBotEntry(targetBot);
    } catch {
      // archiveBotEntry 已保留可见错误。
    } finally {
      archiveFlight.current = false;
      if (sessionRef.current === session) {
        setActiveModal((cur) =>
          cur?.kind === 'archiveBot' && cur.bot.deviceId === targetBot.deviceId && cur.bot.botId === targetBot.botId
            ? null
            : cur,
        );
      }
    }
  }

  async function fetchLatestScopeForDelete(scopeInfo: ScopeInfo, reqId: string) {
    const scopeId = scopeInfo.scope.scopeId;
    const wApi = resolveRoomApi(scopeInfo, 'members');
    const wIdentity = wApi?.identity;
    if (!wApi || !wIdentity || !wApi.transportConnected) {
      updateDeleteGroupModal(scopeId, (cur) => ({
        ...cur,
        loadingLatest: false,
        loadError: t('所属设备当前未连接或离线，无法读取最新群状态以解散群聊。', 'Authority device is offline or disconnected; unable to load latest group state.'),
      }));
      return;
    }
    const localSess = sessionKey(wIdentity);
    updateDeleteGroupModal(scopeId, (cur) => ({
      ...cur,
      loadingLatest: true,
      loadError: null,
      deleteError: null,
    }));
    try {
      const latest = await wApi.call(wIdentity, 'getScopeState', { scopeId });
      if (sessionKey(wApi.identity) !== localSess) return;
      if (latest.scope.deletedAt) {
        removePin(roomPinKey(scopeId));
        markGroupDeleted(scopeId);
        setStage((cur) => {
          if (cur && cur.kind === 'scope' && cur.scopeId === scopeId) {
            setRoomSettingsOpen(false);
            return null;
          }
          return cur;
        });
        updateDeleteGroupModal(scopeId, () => null);
        refreshGroups();
        return;
      }
      updateDeleteGroupModal(scopeId, (cur) => ({
        ...cur,
        latestScope: latest,
        requestId: reqId,
        loadingLatest: false,
        loadError: null,
      }));
    } catch (e) {
      if (sessionKey(wApi.identity) === localSess) {
        reportUnlessTargetOffline(wApi, e);
        updateDeleteGroupModal(scopeId, (cur) => ({
          ...cur,
          loadingLatest: false,
          loadError: t(`读取最新群状态失败：${errText(e)}；请重试读取后再确认解散。`, `Failed to load latest group state: ${errText(e)}; retry before dissolving.`),
        }));
      }
    }
  }

  function openConfirmDeleteGroup(g: (typeof groupRows)[number]) {
    const scopeId = g.scope.scope.scopeId;
    const reqId = crypto.randomUUID();
    const opened = openModal({
      kind: 'deleteGroup',
      state: {
        scopeId,
        title: g.title,
        initialScope: g.scope,
        latestScope: null,
        requestId: reqId,
        loadingLatest: true,
        loadError: null,
        deleting: false,
        deleteError: null,
        lockedUnknown: false,
      },
    });
    if (opened) void fetchLatestScopeForDelete(g.scope, reqId);
  }

  async function executeDeleteGroup() {
    if (activeModal?.kind !== 'deleteGroup' || deleteGroupFlight.current) return;
    const deleteGroupState = activeModal.state;
    if (
      deleteGroupState.loadingLatest ||
      deleteGroupState.deleting ||
      deleteGroupState.lockedUnknown ||
      !deleteGroupState.latestScope
    ) {
      return;
    }
    const { latestScope, requestId } = deleteGroupState;
    const scopeId = latestScope.scope.scopeId;
    const expectedRevision = latestScope.scope.revision;
    const wApi = resolveRoomApi(latestScope, 'members');
    const wIdentity = wApi?.identity;
    if (!wApi || !wIdentity || !wApi.transportConnected) {
      updateDeleteGroupModal(scopeId, (cur) => ({
        ...cur,
        deleteError: t('所属设备当前未连接或离线，无法执行解散并删除。', 'Authority device is offline or disconnected; unable to dissolve group.'),
      }));
      return;
    }
    const localSess = sessionKey(wIdentity);
    deleteGroupFlight.current = true;
    updateDeleteGroupModal(scopeId, (cur) => ({ ...cur, deleting: true, deleteError: null }));
    try {
      await wApi.mutateIntent(wIdentity, 'deleteScope', {
        scopeId,
        input: {
          requestId,
          expectedRevision,
        },
      });
      if (sessionKey(wApi.identity) !== localSess) return;
      removePin(roomPinKey(scopeId));
      markGroupDeleted(scopeId);
      setStage((cur) => {
        if (cur && cur.kind === 'scope' && cur.scopeId === scopeId) {
          setRoomSettingsOpen(false);
          return null;
        }
        return cur;
      });
      updateDeleteGroupModal(scopeId, () => null);
      refreshGroups();
    } catch (e) {
      reportUnlessTargetOffline(wApi, e);
      if (sessionKey(wApi.identity) !== localSess) return;
      const code = (e as { code?: string })?.code;
      const outcome = (e as { outcome?: string })?.outcome;
      if (isNotSent(e)) {
        updateDeleteGroupModal(scopeId, (cur) => ({
          ...cur,
          deleting: false,
          deleteError: t(`解散请求尚未发出：${errText(e)}；可重试。`, `Dissolve request not sent: ${errText(e)}; you can retry.`),
        }));
      } else if (outcome === 'responded') {
        if (code === 'REVISION_CONFLICT' || code === 'REQUEST_CONFLICT') {
          updateDeleteGroupModal(scopeId, (cur) => ({
            ...cur,
            latestScope: null,
            requestId: crypto.randomUUID(),
            deleting: false,
            deleteError: t('群状态已被更新（版本冲突），请点击“重新读取最新状态”后再确认解散。', 'Group state changed (revision conflict). Reload latest state before dissolving.'),
          }));
        } else {
          updateDeleteGroupModal(scopeId, (cur) => ({
            ...cur,
            deleting: false,
            deleteError: t('解散并删除群聊失败：', 'Failed to dissolve group: ') + errText(e),
          }));
        }
      } else {
        updateDeleteGroupModal(scopeId, (cur) => ({
          ...cur,
          deleting: false,
          lockedUnknown: true,
          deleteError: t(`解散结果尚未确认：${errText(e)}；为防重复提交已锁定，请关闭弹窗并刷新群列表核对状态，不会自动重试。`, `Dissolve outcome unconfirmed: ${errText(e)}. Locked to prevent duplicate submission; close and refresh group list to verify.`),
        }));
      }
    } finally {
      deleteGroupFlight.current = false;
    }
  }

  function deviceNameOf(deviceId: string): string {
    return devices.find((d) => d.deviceId === deviceId)?.displayName || '未命名设备';
  }

  function botDisplayNameOf(deviceId: string, botId: string): string {
    return (
      bots.find((b) => b.deviceId === deviceId && b.botId === botId)?.role ||
      '已移除的 Bot'
    );
  }

  function openDmList(member: MessageMember) {
    setRoomSettingsOpen(false);
    setStage({
      kind: 'dm',
      member,
      name: botDisplayNameOf(member.deviceId, member.botId),
      deviceId: member.deviceId,
    });
    setDmScopeId(null);
  }

  function deviceOnlineOf(deviceId: string): boolean {
    return devices.find((d) => d.deviceId === deviceId)?.online ?? false;
  }

  function renderGroupRow(g: (typeof groupRows)[number], pinned: boolean) {
    const scopeId = g.scope.scope.scopeId;
    const chatKey = roomPinKey(scopeId);
    const isSelected = stage?.kind === 'scope' && stage.scopeId === scopeId;
    const rowNode = (
      <ConversationRow
        className="hub-bot-row"
        title={g.title}
        preview={plainPreview(g.lastPreview)}
        timestamp={g.lastActivityAt}
        selected={isSelected}
        unread={unread.has(chatKey)}
        pinned={pinned}
        groupLabel="群聊"
        avatar={
          <ConversationGroupAvatar members={g.scope.scope.members} bots={bots} size={34} />
        }
        onOpen={() => {
          setRoomSettingsOpen(false);
          setStage({
            kind: 'scope',
            scopeId,
            deviceId: g.identity.targetDeviceId,
          });
        }}
        onOpenMenu={(position) => openContextMenu(position, { kind: 'group', group: g })}
      />
    );
    return (
      <li key={chatKey}>
        {pinned ? (
          <SortablePinnedChat
            chatKey={chatKey}
            keys={visiblePinnedKeys}
            onReorder={handleReorderPinned}
          >
            {rowNode}
          </SortablePinnedChat>
        ) : (
          rowNode
        )}
      </li>
    );
  }

  function plainPreview(raw: string | null | undefined): string | undefined {
    if (!raw) return undefined;
    const cleaned = raw
      .replace(/```[\s\S]*?```/g, ' [代码] ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/^#+\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || undefined;
  }

  function renderBotRow(b: BotDirectoryEntry, pinned: boolean) {
    const chatKey = botPinKey(b.deviceId, b.botId);
    const isSelected =
      !stage && selected?.deviceId === b.deviceId && selected.botId === b.botId;
    const isBotOnline = Boolean(b.online && online);
    const activityIso = b.lastActivityAt || b.createdAt;
    const rowNode = (
      <ConversationRow
        className="hub-bot-row"
        title={b.role}
        timestamp={activityIso}
        selected={isSelected}
        unread={unread.has(chatKey)}
        pinned={pinned}
        connectionLabel={isBotOnline ? '在线' : '未连接'}
        avatar={
          <GrokBotAvatar
            botKey={botAvatarKey(b)}
            roleName={b.role}
            isPrimary={b.isPrimary}
            offline={!isBotOnline}
            size={34}
          />
        }
        onOpen={() => {
          setReturnTaskId(null);
          setJumpedTaskQuote(null);
          setSelected({ deviceId: b.deviceId, botId: b.botId });
          setRoomSettingsOpen(false);
          setStage(null);
        }}
        onOpenMenu={(position) => openContextMenu(position, { kind: 'bot', bot: b })}
      />
    );
    return (
      <li key={chatKey}>
        {pinned ? (
          <SortablePinnedChat
            chatKey={chatKey}
            keys={visiblePinnedKeys}
            onReorder={handleReorderPinned}
          >
            {rowNode}
          </SortablePinnedChat>
        ) : (
          rowNode
        )}
      </li>
    );
  }

  const contextMenuItems = useMemo<ConversationMenuItem[] | undefined>(() => {
    if (!menu) return undefined;
    if (menu.target.kind === 'group') {
      const g = menu.target.group;
      const scopeId = g.scope.scope.scopeId;
      const pinKey = roomPinKey(scopeId);
      const pinned = isPinned(pinKey);
      const authorityApi = resolveRoomApi(g.scope, 'members');
      const canDeleteGroup = Boolean(online && authorityApi && authorityApi.transportConnected);
      return [
        {
          key: 'view-details',
          label: '查看群详情',
          icon: <Users size={15} aria-hidden="true" />,
          onSelect: () => {
            setMenu(null);
            setRoomSettingsOpen(true);
            setStage({
              kind: 'scope',
              scopeId,
              deviceId: g.identity.targetDeviceId,
            });
          },
        },
        {
          key: 'toggle-pin',
          label: pinned ? '取消置顶' : '置顶',
          icon: pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />,
          onSelect: () => {
            setMenu(null);
            togglePin(pinKey);
          },
        },
        {
          key: 'delete-group',
          label: '解散并删除群聊',
          icon: <Trash2 size={15} aria-hidden="true" />,
          danger: true,
          disabled: !canDeleteGroup,
          onSelect: () => {
            setMenu(null);
            openConfirmDeleteGroup(g);
          },
        },
      ];
    }
    const b = menu.target.bot;
    const isArchived = Boolean(b.archivedAt);
    const canPin = !(b.isPrimary && b.deviceId === currentDeviceId) && !isArchived;
    const canDeleteOrArchive = !b.isPrimary;
    const pinKey = botPinKey(b.deviceId, b.botId);
    const pinned = isPinned(pinKey);
    const botOnline = Boolean(b.online && online);
    const items: ConversationMenuItem[] = [
      {
        key: 'view-profile',
        label: t('查看资料', 'View profile'),
        icon: <User size={15} aria-hidden="true" />,
        onSelect: () => {
          setMenu(null);
          setSelected({ deviceId: b.deviceId, botId: b.botId });
          setRoomSettingsOpen(false);
          setStage(null);
          setInspectorRequest({
            deviceId: b.deviceId,
            botId: b.botId,
            tab: 'profile',
            seq: ++inspectorSeqRef.current,
          });
        },
      },
    ];
    // 置顶资格：仅当前设备 Hero 主 Bot 不提供置顶；远端主 Bot 在列表中可正常置顶。
    if (canPin) {
      items.push({
        key: 'toggle-pin',
        label: pinned ? '取消置顶' : '置顶',
        icon: pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />,
        onSelect: () => {
          setMenu(null);
          togglePin(pinKey);
        },
      });
    }
    items.push({
      key: 'view-dm',
      label: '查看 Bot 间私聊',
      icon: <MessageSquare size={15} aria-hidden="true" />,
      onSelect: () => {
        setMenu(null);
        openDmList({ deviceId: b.deviceId, botId: b.botId });
      },
    });
    // 主 Bot 保护：任何设备的主 Bot 不可直接归档或删除。
    if (canDeleteOrArchive && !isArchived) {
      items.push({
        key: 'archive-bot',
        label: t('归档 Bot', 'Archive bot'),
        icon: <Archive size={15} aria-hidden="true" />,
        disabled: !botOnline,
        onSelect: () => {
          openModal({ kind: 'archiveBot', bot: b, archiving: false });
        },
      });
    }
    if (canDeleteOrArchive) {
      items.push({
        key: 'delete-bot',
        label: t('永久删除 Bot', 'Delete bot permanently'),
        icon: <Trash2 size={15} aria-hidden="true" />,
        danger: true,
        disabled: !botOnline,
        onSelect: () => {
          openModal({ kind: 'deleteBot', bot: b, deleting: false, error: null });
        },
      });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, isPinned, online, resolveRoomApi, togglePin, devices, currentDeviceId, openModal, t]);

  const archiveModal = activeModal?.kind === 'archiveBot' ? activeModal : null;
  const deleteBotModal = activeModal?.kind === 'deleteBot' ? activeModal : null;
  const deleteGroupModal = activeModal?.kind === 'deleteGroup' ? activeModal.state : null;
  const groupToDissolve = deleteGroupModal?.latestScope ?? deleteGroupModal?.initialScope;
  const dissolveDeviceNames = groupToDissolve
    ? [...new Set(groupToDissolve.scope.members.map(member => member.deviceId))].map(deviceNameOf)
    : [];

  shortcutStateRef.current = {
    canChatShortcut: Boolean(!stage && scopedApi && selectedBot),
    modalOpen: activeModal !== null,
  };

  if (tasksActive) return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%' }}>
      {taskBoardNotice ? (
        <InlineBanner
          compact
          tone="danger"
          className="chat-top-banner"
          title={taskBoardNotice}
          onDismiss={() => setTaskBoardNotice('')}
        />
      ) : null}
      <TaskBoardView
        variant="desktop"
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
        onJumpToChat={({ deviceId, botId, taskId, stepId }) => {
          const hasDeviceId = Boolean(deviceId && deviceId.trim());
          const targetBot = hasDeviceId
            ? (bots.find((b) => !b.archivedAt && b.deviceId === deviceId && b.botId === botId) ??
              bots.find((b) => b.deviceId === deviceId && b.botId === botId))
            : (bots.find((b) => !b.archivedAt && b.botId === botId) ??
              bots.find((b) => b.botId === botId));
          const unreachableLocal = Boolean(
            targetBot && identity?.kind === 'local' && targetBot.deviceId !== identity.targetDeviceId,
          );
          if (!targetBot || unreachableLocal) {
            setTaskBoardNotice(
              hasDeviceId
                ? `目标 Bot 不可用（设备 ${deviceId} · ${botId} 不在当前可用目录中）`
                : `目标 Bot 不可用（${botId} 不在当前可用目录中）`,
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
          setReturnTaskId(taskId);
          setSelected({ deviceId: targetBot.deviceId, botId: targetBot.botId, focusComposer: true });
          setDeviceFilter('all');
          setStage(null);
          setRoomSettingsOpen(false);
          onSwitchView?.('chat');
        }}
      />
    </div>
  );

  if (boardActive) return <BotBoard
    variant="desktop"
    targets={boardTargets}
    board={board}
    loading={!loaded || loading}
    error={botsError}
    onOpenTask={(taskId) => {
      setActiveTaskId(taskId);
      setCreatingTask(false);
      setTaskInitialEditMode(false);
      onSwitchView?.('tasks');
    }}
    onOpen={(target, questionnaire) => {
      const bot = boardBots.find(bot => botBoardKey(profileKey, bot.deviceId, bot.botId) === target.key);
      if (!bot) return;
      setReturnTaskId(null);
      setJumpedTaskQuote(null);
      setSelected({
        deviceId: bot.deviceId,
        botId: bot.botId,
        questionnaire: questionnaire?.conversationId === bot.primaryConversationId
          ? { ...questionnaire, session: sess }
          : undefined,
      });
      setDeviceFilter('all');
      setStage(null);
      setRoomSettingsOpen(false);
      onSwitchView ? onSwitchView('chat') : onOpenBoardChat?.();
    }}
  />;

  const sidebarAddMenuItems: PopoverMenuItem[] = [
    {
      key: 'create-bot',
      label: t('新建 Bot', 'Create bot'),
      icon: <Sparkles size={16} aria-hidden="true" />,
      disabled: !identity,
      onSelect: () => {
        const preferredDevice = [stage?.deviceId, selectedBot?.deviceId, deviceFilter, currentDeviceId]
          .find(id => onlineDevices.some(device => device.deviceId === id));
        openModal({ kind: 'createBot', targetDeviceId: preferredDevice ?? onlineDevices[0]?.deviceId ?? '' });
      },
    },
    {
      key: 'create-group',
      label: t('创建群聊', 'Create group'),
      icon: <Users size={16} aria-hidden="true" />,
      disabled: !identity,
      onSelect: () => openModal({ kind: 'createGroup' }),
    },
  ];

  const sidebarBanner = botActionError ? (
    <InlineBanner
      compact
      tone="danger"
      className="hub-sidebar-banner"
      title={botActionError}
      onDismiss={() => setBotActionError(null)}
    />
  ) : botsError ? (
    <InlineBanner
      compact
      tone="danger"
      className="hub-sidebar-banner"
      title={botsError}
      actions={
        <button type="button" className="secondary-button" onClick={() => triggerLoadBots()}>
          {t('重试', 'Retry')}
        </button>
      }
    />
  ) : groupsError ? (
    <InlineBanner
      compact
      tone="danger"
      className="hub-sidebar-banner"
      title={t('群聊列表读取失败', 'Failed to load groups')}
      detail={groupsError}
      actions={
        <button type="button" className="secondary-button" onClick={() => refreshGroups()}>
          {t('重试', 'Retry')}
        </button>
      }
    />
  ) : pinsError ? (
    <InlineBanner
      compact
      tone="attention"
      className="hub-sidebar-banner"
      title={pinsError}
    />
  ) : !online && !centerInterrupted ? (
    <InlineBanner
      compact
      tone="attention"
      role="status"
      className="hub-sidebar-banner"
      title={t('当前离线', 'Offline')}
      detail={t('正在显示最后同步的 Bot 列表。', 'Showing last cached conversation list.')}
    />
  ) : null;

  return (
    <div className={`bot-chats-layout${listCollapsed ? ' list-collapsed' : ''}`}>
      <aside className="hub-sidebar" aria-label={t('Bot 名录', 'Conversation directory')}>
        <div className="hub-hero-strip" role="list" aria-label={t('主 Bot', 'Primary bots')}>
          {primaryBots.map((b) => (
            <HeroBotCard
              key={`${b.deviceId}:${b.botId}`}
              role="listitem"
              className={`hub-hero-card${!stage && selected?.deviceId === b.deviceId && selected.botId === b.botId ? ' selected' : ''}`}
              onOpen={() => {
                setReturnTaskId(null);
                setJumpedTaskQuote(null);
                setSelected({ deviceId: b.deviceId, botId: b.botId });
                setRoomSettingsOpen(false);
                setStage(null);
              }}
              onOpenMenu={(position) => openContextMenu(position, { kind: 'bot', bot: b })}
            >
              <GrokBotAvatar
                botKey={botAvatarKey(b)}
                roleName={b.role}
                isPrimary
                starBadge
                platformBadge={b.platform || 'host'}
                offline={!b.online || !online}
                size={44}
              />
              <span className="hub-hero-info">
                <span className="hub-hero-name">{b.role}</span>
                {devices.length > 1 || bots.some(other => other !== b && !other.archivedAt && other.role === b.role) || !b.online || !online ? (
                  <span className={`hub-hero-node${b.online && online ? '' : ' offline'}`}>
                    {[
                      devices.length > 1 || bots.some(other => other !== b && !other.archivedAt && other.role === b.role)
                        ? deviceNameOf(b.deviceId) : '',
                      !b.online || !online ? t('离线', 'Offline') : '',
                    ].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </span>
            </HeroBotCard>
          ))}
          {missingPrimaryDevices.map((d) => (
            <button
              key={d.deviceId}
              type="button"
              role="listitem"
              className="hub-hero-card hub-hero-create"
              title={t(`在 ${d.displayName || '未命名设备'} 创建主 Bot`, `Create primary bot on ${d.displayName || 'Unnamed device'}`)}
              onClick={() => openModal({ kind: 'createBot', targetDeviceId: d.deviceId })}
            >
              <span className="hub-hero-plus" aria-hidden="true">＋</span>
              <span className="hub-hero-info">
                <span className="hub-hero-name">{t('创建主 Bot', 'Create primary bot')}</span>
                <span className="hub-hero-node">{d.displayName || t('未命名设备', 'Unnamed device')}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="hub-search-row">
          <div className="hub-search-wrap">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('搜索对话…', 'Search conversations…')}
              aria-label={t('搜索 Bot 或群聊', 'Search bots or groups')}
            />
            {query ? (
              <button
                type="button"
                className="icon-button"
                onClick={() => setQuery('')}
                aria-label={t('清除搜索', 'Clear search')}
              >
                <X size={13} aria-hidden="true" />
              </button>
            ) : (
              <kbd className="hub-search-kbd" aria-hidden="true">{SHORTCUT_K_KBD}</kbd>
            )}
          </div>
          <PopoverMenu
            align="end"
            side="bottom"
            ariaLabel={t('新建 Bot 或群聊', 'Create bot or group')}
            items={sidebarAddMenuItems}
            trigger={({ triggerProps }) => (
              <button
                {...triggerProps}
                type="button"
                className="icon-button hub-top-add-btn"
                disabled={!identity}
                aria-label={t('新建 Bot 或群聊', 'Create bot or group')}
                title={t('新建 Bot 或创建群聊', 'Create bot or group')}
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            )}
          />
          <button
            ref={collapseSidebarBtnRef}
            type="button"
            className="icon-button hub-collapse-btn"
            onClick={handleCollapseSidebarClick}
            aria-label={t('收起会话列表', 'Collapse conversation list')}
            aria-expanded={!listCollapsed}
            title={t(`收起会话列表（${SHORTCUT_MOD_LABEL}B）`, `Collapse conversation list (${SHORTCUT_MOD_LABEL}B)`)}
          >
            <PanelLeftClose size={16} aria-hidden="true" />
          </button>
        </div>

        {devices.length > 1 ? (
          <div className="hub-device-filter">
            <Select
              size="sm"
              value={deviceFilter}
              onChange={setDeviceFilter}
              ariaLabel={t('按设备筛选', 'Filter by device')}
              options={[
                { value: 'all', label: t('所有设备', 'All devices') },
                ...devices.map(device => ({
                  value: device.deviceId,
                  label: `${device.displayName || t('未命名设备', 'Unnamed device')}${device.online && online ? '' : t(' · 离线', ' · Offline')}`,
                })),
              ]}
            />
          </div>
        ) : null}

        {sidebarBanner}

        <div className="hub-list-scroll">
          {loading && !loaded ? (
            <div className="status">{t('加载中…', 'Loading…')}</div>
          ) : !loaded ? (
            <div className="status">{t('目录尚未读取。', 'Directory not loaded yet.')}</div>
          ) : primaryBots.length === 0 && regularBots.length === 0 && groupRows.length === 0 && !botsError ? (
            <div className="empty-state">
              {query || deviceFilter !== 'all'
                ? t('没有匹配的 Bot 或群聊。', 'No matching bots or groups.')
                : t('暂无会话，可点击上方 ＋ 新建 Bot 或创建群聊。', 'No conversations yet. Use + above to create a bot or group.')}
            </div>
          ) : (
            <>
              {mixedRows.length > 0 ? (
                <ul className="hub-bot-list">
                  {mixedRows.map((row) =>
                    row.kind === 'bot'
                      ? renderBotRow(row.bot, row.pinned)
                      : renderGroupRow(row.group, row.pinned),
                  )}
                </ul>
              ) : null}
              {groupsLoading ? <div className="status">{t('群聊加载中…', 'Loading groups…')}</div> : null}
            </>
          )}
        </div>
      </aside>

      <section className="main-stage">
        {stage?.kind === 'dm' && stageApi ? (
          <div className="scope-main-stage">
            {listCollapsed ? (
              <div className="stage-reopen-bar">
                <button
                  ref={scopeExpandSidebarBtnRef}
                  type="button"
                  className="secondary-button stage-reopen-btn"
                  onClick={handleExpandSidebarClick}
                  aria-expanded={false}
                  title={t(`展开会话列表（${SHORTCUT_MOD_LABEL}B）`, `Expand conversation list (${SHORTCUT_MOD_LABEL}B)`)}
                >
                  <PanelLeftOpen size={15} aria-hidden="true" />
                  <span>{t('展开会话列表', 'Expand conversations')}</span>
                </button>
              </div>
            ) : null}
            <Scopes
              key={JSON.stringify(['dm', profileKey, stage.member.deviceId, stage.member.botId])}
              api={stageApi}
              pageActive={pageActive}
              readOnly
              variant="desktop"
              scopeKind="dm"
              resolveMemberApi={resolveMemberApi}
              participant={stage.member}
              participantName={stage.name}
              selectedScopeId={dmScopeId}
              onSelectScope={setDmScopeId}
              onBack={() => setStage(null)}
              knownBots={scopeKnownBots}
              onOpenLink={openScopeLink}
              onOpenBot={(botId, deviceId) => {
                setDeviceFilter(deviceId);
                setSelected({ deviceId, botId });
                setStage(null);
              }}
            />
          </div>
        ) : stage?.kind === 'scope' && stageApi ? (
          <div className="scope-main-stage">
            {listCollapsed ? (
              <div className="stage-reopen-bar">
                <button
                  ref={scopeExpandSidebarBtnRef}
                  type="button"
                  className="secondary-button stage-reopen-btn"
                  onClick={handleExpandSidebarClick}
                  aria-expanded={false}
                  title={t(`展开会话列表（${SHORTCUT_MOD_LABEL}B）`, `Expand conversation list (${SHORTCUT_MOD_LABEL}B)`)}
                >
                  <PanelLeftOpen size={15} aria-hidden="true" />
                  <span>{t('展开会话列表', 'Expand conversations')}</span>
                </button>
              </div>
            ) : null}
            <Scopes
              key={JSON.stringify(['scope', profileKey, stage.deviceId, stage.scopeId])}
              api={stageApi}
              pageActive={pageActive}
              scopeKind="room"
              variant="desktop"
              detailOnly
              onOpenSendRecords={onOpenSendRecords}
              onHistoryViewed={chatWorkspaceActive && !roomSettingsOpen ? onRoomHistoryViewed : undefined}
              initialScopeId={stage.scopeId}
              initialScope={
                stage.initialScope ??
                groupRows.find((g) => g.scope.scope.scopeId === stage.scopeId)?.scope ??
                null
              }
              resolveRoomApi={resolveRoomApi}
              memberCandidates={scopeMemberCandidates}
              settingsOpen={roomSettingsOpen}
              onSettingsOpenChange={setRoomSettingsOpen}
              onDeleted={() => {
                removePin(roomPinKey(stage.scopeId));
                markGroupDeleted(stage.scopeId);
                setRoomSettingsOpen(false);
                setStage(null);
                refreshGroups();
              }}
              onBack={() => {
                setRoomSettingsOpen(false);
                setStage(null);
              }}
              knownBots={scopeKnownBots}
              onOpenLink={openScopeLink}
              onOpenBot={(botId, deviceId) => {
                setDeviceFilter(deviceId);
                setSelected({ deviceId, botId });
                setRoomSettingsOpen(false);
                setStage(null);
              }}
            />
          </div>
        ) : null}
        {scopedApi && selectedBot ? (() => {
          const cutoffKey = JSON.stringify([profileKey, selectedBot.deviceId, selectedBot.botId, selectedBot.primaryConversationId]);
          return (
          <div className={stage ? 'chat-stage-host stage-hidden' : 'chat-stage-host'}>
          <PrimaryChatPane
            key={cutoffKey}
            api={scopedApi}
            centerApi={api}
            bot={selectedBot}
            knownBots={scopeKnownBots}
            readScope={readScopeFor(selectedBot.deviceId, selectedBot.botId)}
            initialClearedThroughEntryId={clearedCutoffsRef.current.get(cutoffKey) ?? 0}
            onClearedThroughEntryId={(cutoff) => {
              const prev = clearedCutoffsRef.current.get(cutoffKey) ?? 0;
              if (cutoff > prev) clearedCutoffsRef.current.set(cutoffKey, cutoff);
            }}
            deviceName={selectedDeviceName}
            devicePlatform={selectedDevicePlatform}
            focusComposer={selected?.focusComposer}
            listCollapsed={listCollapsed}
            onExpandSidebar={handleExpandSidebarClick}
            expandSidebarButtonRef={chatExpandSidebarBtnRef}
            onOpenSendRecords={onOpenSendRecords}
            onOpenCenterAdmin={onOpenCenterAdmin}
            questionnaireRequestId={selected?.questionnaire?.session === sess &&
              selected.questionnaire.conversationId === selectedBot.primaryConversationId
              ? selected.questionnaire.requestId : undefined}
            onQuestionnaireFocused={onQuestionnaireFocused}
            centerInterrupted={centerInterrupted}
            inspectorRequest={
              inspectorRequest &&
              inspectorRequest.deviceId === selectedBot.deviceId &&
              inspectorRequest.botId === selectedBot.botId
                ? { tab: inspectorRequest.tab, seq: inspectorRequest.seq }
                : null
            }
            onInspectorRequestConsumed={(consumedSeq) => {
              setInspectorRequest((cur) => (cur && cur.seq === consumedSeq ? null : cur));
            }}
            onProfileSaved={(updated) => {
              setBots((old) =>
                old.map((b) =>
                  b.deviceId === updated.deviceId && b.botId === updated.botId
                    ? { ...b, ...updated }
                    : b,
                ),
              );
              triggerLoadBots();
            }}
            onBotUpdated={(patch) => {
              const targetDeviceId = selectedBot.deviceId;
              // 远端 Bot 设为主后仍在下方列表，保留 pin；仅本机 Bot 升主进入 Hero 或 Bot 归档时移除 pin。
              if (patch.archivedAt || (patch.isPrimary && targetDeviceId === currentDeviceId)) {
                removePin(botPinKey(targetDeviceId, patch.botId));
              }
              setBots((old) =>
                old.map((b) => {
                  if (b.deviceId !== targetDeviceId) return b;
                  if (b.botId === patch.botId) return { ...b, ...patch };
                  if (patch.isPrimary) return { ...b, isPrimary: false };
                  return b;
                }),
              );
              triggerLoadBots();
            }}
            onBotDeleted={(deletedBotId) => {
              const targetDeviceId = selectedBot.deviceId;
              seq.current += 1;
              removePin(botPinKey(targetDeviceId, deletedBotId));
              setSelected(null);
              setBotDeletionNotice(`「${selectedBot.role}」已删除`);
              setBots((old) =>
                old.filter(
                  (b) => !(b.deviceId === targetDeviceId && b.botId === deletedBotId),
                ),
              );
              triggerLoadBots();
              refreshGroups();
            }}
            onLiveActivity={handleLiveActivity}
            onOpenPrivateChats={(bot) =>
              openDmList({ deviceId: bot.deviceId, botId: bot.botId })
            }
            tasks={effectiveGlobalTasks}
            taskBots={taskBotOptions}
            taskScopeKey={taskScopeKey}
            jumpedTaskId={
              jumpedTaskQuote &&
              jumpedTaskQuote.deviceId === selectedBot.deviceId &&
              jumpedTaskQuote.botId === selectedBot.botId
                ? jumpedTaskQuote.taskId
                : null
            }
            jumpedStepId={
              jumpedTaskQuote &&
              jumpedTaskQuote.deviceId === selectedBot.deviceId &&
              jumpedTaskQuote.botId === selectedBot.botId
                ? jumpedTaskQuote.stepId
                : null
            }
            waitingTaskOffset={waitingTaskOffsetByBot[`${selectedBot.deviceId}:${selectedBot.botId}`] ?? 0}
            returnTaskId={returnTaskId}
            taskActionFailure={taskActionFailures[`${taskScopeKey}|${selectedBot.deviceId}:${selectedBot.botId}`] ?? null}
            taskActionRetrying={retryingTaskActionKey === `${taskScopeKey}|${selectedBot.deviceId}:${selectedBot.botId}`}
            onClearTaskQuote={() => setJumpedTaskQuote(null)}
            onCycleWaitingTask={() => {
              const botKey = `${selectedBot.deviceId}:${selectedBot.botId}`;
              setJumpedTaskQuote(null);
              setWaitingTaskOffsetByBot((prev) => ({ ...prev, [botKey]: (prev[botKey] ?? 0) + 1 }));
            }}
            onOpenTask={(taskId, openEdit) => {
              setActiveTaskId(taskId);
              setCreatingTask(false);
              setTaskInitialEditMode(Boolean(openEdit));
              onSwitchView?.('tasks');
            }}
            onReturnToTask={(taskId) => {
              setActiveTaskId(taskId);
              setCreatingTask(false);
              setTaskInitialEditMode(false);
              onSwitchView?.('tasks');
            }}
            onRunTaskAction={executeTaskChatAction}
            onRetryTaskAction={() => {
              const failure = taskActionFailures[`${taskScopeKey}|${selectedBot.deviceId}:${selectedBot.botId}`];
              if (failure) void retryTaskChatAction(failure);
            }}
            onDismissTaskAction={() => {
              const failure = taskActionFailures[`${taskScopeKey}|${selectedBot.deviceId}:${selectedBot.botId}`];
              if (failure) dismissTaskChatAction(failure);
            }}
            transcriptVisible={activeModal === null}
            pageActive={chatWorkspaceActive && !stage}
            chatWorkspaceActive={chatWorkspaceActive}
          />
          </div>
          );
        })() : null}
        {!stage && !(scopedApi && selectedBot) ? (
          <div className="empty-state stage-empty">
            <span className="title" role="status">
              {botDeletionNotice || (listCollapsed ? t('会话列表已收起', 'Conversation list collapsed') : t('选择左侧 Bot 开始对话', 'Select a bot on the left to start chatting'))}
            </span>
            {listCollapsed ? (
              <button
                ref={emptyExpandSidebarBtnRef}
                type="button"
                className="secondary-button stage-reopen-btn"
                onClick={handleExpandSidebarClick}
                aria-expanded={false}
                title={t(`展开会话列表（${SHORTCUT_MOD_LABEL}B）`, `Expand conversation list (${SHORTCUT_MOD_LABEL}B)`)}
              >
                <PanelLeftOpen size={15} aria-hidden="true" />
                <span>{t('展开会话列表', 'Expand conversations')}</span>
              </button>
            ) : null}
            {onlineDevices.length > 0 ? t(`或使用 ${SHORTCUT_MOD_LABEL}K 快速搜索`, `Or press ${SHORTCUT_MOD_LABEL}K to search`) : null}
          </div>
        ) : null}
      </section>

      <Dialog.Root open={activeModal?.kind === 'createBot'} onOpenChange={(open) => { if (!open) closeModal(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="desktop-dialog-overlay" />
          <Dialog.Content
            className="desktop-dialog create-bot-dialog"
            {...FLOATING_OUTSIDE_GUARD_PROPS}
            onEscapeKeyDown={(event) => {
              if (hasOpenFloatingPopover()) event.preventDefault();
            }}
          >
            <div className="desktop-dialog-head">
              <Dialog.Title>{t('新建 Bot', 'Create bot')}</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="icon-button" aria-label={t('关闭', 'Close')}>
                  <X size={16} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">
              {t('填写名称、职责、模型与目标设备，创建新的 Bot。', 'Fill in name, role, model, and target device to create a new bot.')}
            </Dialog.Description>
            {identity && activeModal?.kind === 'createBot' ? (
              <CreateBotForm
                key={activeModal.targetDeviceId || 'default'}
                api={api}
                devices={devices}
                bots={bots}
                initialDeviceId={activeModal.targetDeviceId}
                onCancel={() => closeModal()}
                onCreated={(deviceId, bot) => {
                  closeModal(true);
                  setSelected({ deviceId, botId: bot.botId });
                  const dev = devices.find((d) => d.deviceId === deviceId);
                  setBots((old) => {
                    const cleared = bot.isPrimary
                      ? old.map((b) => (b.deviceId === deviceId ? { ...b, isPrimary: false } : b))
                      : old;
                    return [
                      ...cleared.filter((b) => b.deviceId !== deviceId || b.botId !== bot.botId),
                      {
                        ...bot,
                        deviceName: dev?.displayName || t('未命名设备', 'Unnamed device'),
                        platform: dev?.platform,
                        online: true,
                      },
                    ];
                  });
                  triggerLoadBots();
                }}
              />
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={activeModal?.kind === 'createGroup'} onOpenChange={(open) => { if (!open) closeModal(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="desktop-dialog-overlay" />
          <Dialog.Content
            className="desktop-dialog create-bot-dialog create-group-dialog"
            {...FLOATING_OUTSIDE_GUARD_PROPS}
            onEscapeKeyDown={(event) => {
              if (hasOpenFloatingPopover()) event.preventDefault();
            }}
          >
            <div className="desktop-dialog-head">
              <Dialog.Title>{t('创建群聊', 'Create group')}</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="icon-button" aria-label={t('关闭', 'Close')}>
                  <X size={16} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">
              {t('选择至少两位未归档 Bot 组成新的群聊。', 'Select at least two active bots to create a new group.')}
            </Dialog.Description>
            {identity && activeModal?.kind === 'createGroup' ? (
              <CreateGroupForm
                api={api}
                currentDeviceId={currentDeviceId}
                devices={devices}
                bots={bots}
                writeTargetApiMap={roomWriteTargetApiMap}
                frozenAttempt={frozenGroupAttempt}
                onFreezeAttempt={setFrozenGroupAttempt}
                onCancel={() => closeModal()}
                onRequestCreateBot={() => {
                  const preferredDevice = [stage?.deviceId, selectedBot?.deviceId, deviceFilter, currentDeviceId]
                    .find(id => onlineDevices.some(device => device.deviceId === id));
                  openModal({ kind: 'createBot', targetDeviceId: preferredDevice ?? onlineDevices[0]?.deviceId ?? '' });
                }}
                onCreated={(targetDeviceId, scope) => {
                  closeModal(true);
                  setRoomSettingsOpen(false);
                  setStage({
                    kind: 'scope',
                    scopeId: scope.scope.scopeId,
                    deviceId: targetDeviceId,
                    initialScope: scope,
                  });
                  void refreshGroups();
                }}
              />
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={archiveModal !== null} onOpenChange={open => {
        if (!open) closeModal();
      }}>
        <Dialog.Portal>
          <Dialog.Overlay className="desktop-dialog-overlay" />
          <Dialog.Content
            className="desktop-dialog confirm-action-dialog"
            {...FLOATING_OUTSIDE_GUARD_PROPS}
            onEscapeKeyDown={(event) => {
              if (hasOpenFloatingPopover()) event.preventDefault();
            }}
          >
            <div className="desktop-dialog-head"><Dialog.Title>{t('归档 Bot', 'Archive bot')}</Dialog.Title></div>
            <div className="confirm-action-body">
              <Dialog.Description>
                {t(`归档「${archiveModal?.bot.role ?? ''}」后，对话转为只读。归档满 ${ARCHIVE_RETENTION_DAYS} 天会自动清理，期间可在已归档 Bot 中恢复。`, `Archiving "${archiveModal?.bot.role ?? ''}" makes its chat read-only. It auto-deletes after ${ARCHIVE_RETENTION_DAYS} days and can be restored before then.`)}
              </Dialog.Description>
              <ActionBar align="end" className="form-actions">
                <Dialog.Close asChild><button type="button" className="secondary-button" disabled={Boolean(archiveModal?.archiving)}>{t('取消', 'Cancel')}</button></Dialog.Close>
                <button type="button" className="primary-button" onClick={() => void handleConfirmArchive()} disabled={Boolean(archiveModal?.archiving) || !online}>
                  {archiveModal?.archiving ? t('正在归档…', 'Archiving…') : t('归档 Bot', 'Archive bot')}
                </button>
              </ActionBar>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={deleteBotModal !== null}
        onOpenChange={(open) => {
          if (!open) closeModal();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="desktop-dialog-overlay" />
          <Dialog.Content
            className="desktop-dialog confirm-action-dialog"
            {...FLOATING_OUTSIDE_GUARD_PROPS}
            onEscapeKeyDown={(event) => {
              if (hasOpenFloatingPopover()) event.preventDefault();
            }}
          >
            <div className="desktop-dialog-head">
              <Dialog.Title>{t('永久删除 Bot', 'Delete bot permanently')}</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('关闭', 'Close')}
                  disabled={Boolean(deleteBotModal?.deleting)}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            {deleteBotModal ? (
              <div className="confirm-action-body">
                <Dialog.Description>
                  {t(`确定要永久删除 Bot「${deleteBotModal.bot.role}」吗？删除后该 Bot 的所有对话历史与人设配置将永久清除，此操作不可撤销。`, `Permanently delete "${deleteBotModal.bot.role}"? All chat history and persona configuration will be removed and cannot be undone.`)}
                </Dialog.Description>
                {deleteBotModal.error ? (
                  <InlineBanner compact tone="danger" title={deleteBotModal.error} />
                ) : null}
                <ActionBar align="end" className="form-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={deleteBotModal.deleting}
                    onClick={() => closeModal()}
                  >
                    {t('取消', 'Cancel')}
                  </button>
                  <button
                    type="button"
                    className="primary-button danger-button"
                    disabled={deleteBotModal.deleting || !online || !deleteBotModal.bot.online}
                    onClick={() => void handleConfirmDeleteBot()}
                  >
                    {deleteBotModal.deleting ? t('正在删除…', 'Deleting…') : t('永久删除 Bot', 'Delete bot permanently')}
                  </button>
                </ActionBar>
              </div>
            ) : (
              <Dialog.Description className="sr-only">{t('确认永久删除所选 Bot。', 'Confirm permanently deleting the selected bot.')}</Dialog.Description>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={deleteGroupModal !== null}
        onOpenChange={(open) => {
          if (!open) closeModal();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="desktop-dialog-overlay" />
          <Dialog.Content
            className="desktop-dialog confirm-action-dialog"
            {...FLOATING_OUTSIDE_GUARD_PROPS}
            onEscapeKeyDown={(event) => {
              if (hasOpenFloatingPopover()) event.preventDefault();
            }}
          >
            <div className="desktop-dialog-head">
              <Dialog.Title>{t('解散并删除群聊', 'Dissolve & delete group')}</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('关闭', 'Close')}
                  disabled={Boolean(deleteGroupModal?.deleting)}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            {deleteGroupModal ? (
              <div className="confirm-action-body">
                <Dialog.Description>
                  {t(`确定要解散并删除群聊「${deleteGroupModal.title}」吗？`, `Dissolve and permanently delete group "${deleteGroupModal.title}"?`)}
                  {dissolveDeviceNames.length ? t(`涉及 ${dissolveDeviceNames.length} 台参与设备（${dissolveDeviceNames.join('、')}）。`, ` Involves ${dissolveDeviceNames.length} devices (${dissolveDeviceNames.join(', ')}).`) : ''}
                  {t('群聊历史和成员关系会被永久删除。', ' Group history and membership will be permanently deleted.')}
                </Dialog.Description>
                {deleteGroupModal.loadingLatest ? (
                  <InlineBanner compact tone="info" role="status" title={t('正在读取最新群状态…', 'Loading latest group state…')} />
                ) : null}
                {deleteGroupModal.loadError ? (
                  <InlineBanner
                    compact
                    tone="danger"
                    title={deleteGroupModal.loadError}
                    actions={
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          void fetchLatestScopeForDelete(
                            deleteGroupModal.initialScope,
                            deleteGroupModal.requestId,
                          )
                        }
                        disabled={deleteGroupModal.loadingLatest}
                      >
                        {t('重试读取', 'Retry loading')}
                      </button>
                    }
                  />
                ) : null}
                {deleteGroupModal.deleteError ? (
                  <InlineBanner compact tone="danger" title={deleteGroupModal.deleteError} />
                ) : null}
                {!deleteGroupModal.loadingLatest &&
                !deleteGroupModal.loadError &&
                !deleteGroupModal.latestScope &&
                !deleteGroupModal.lockedUnknown ? (
                  <ActionBar align="end" className="form-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() =>
                        void fetchLatestScopeForDelete(
                          deleteGroupModal.initialScope,
                          deleteGroupModal.requestId,
                        )
                      }
                    >
                      {t('重新读取最新状态', 'Reload latest state')}
                    </button>
                  </ActionBar>
                ) : null}
                <ActionBar align="end" className="form-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={deleteGroupModal.deleting}
                    onClick={() => closeModal()}
                  >
                    {t('取消', 'Cancel')}
                  </button>
                  <button
                    type="button"
                    className="primary-button danger-button"
                    disabled={
                      deleteGroupModal.loadingLatest ||
                      deleteGroupModal.deleting ||
                      deleteGroupModal.lockedUnknown ||
                      !deleteGroupModal.latestScope ||
                      !online
                    }
                    onClick={() => void executeDeleteGroup()}
                  >
                    {deleteGroupModal.deleting ? t('正在解散…', 'Dissolving…') : t('解散并删除群聊', 'Dissolve & delete group')}
                  </button>
                </ActionBar>
              </div>
            ) : (
              <Dialog.Description className="sr-only">{t('确认解散并删除所选群聊。', 'Confirm dissolving and deleting the selected group.')}</Dialog.Description>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConversationContextMenu
        position={menu ? { x: menu.x, y: menu.y } : null}
        onClose={() => setMenu(null)}
        items={contextMenuItems}
      />
    </div>
  );
}

/** 主 Bot 英雄卡：同样使用上游交互 hook（点击 + 右键/键盘/触摸菜单），不在 map 内直接调 hook。 */
function HeroBotCard({
  className,
  role,
  children,
  onOpen,
  onOpenMenu,
}: {
  className?: string;
  role?: string;
  children: ReactNode;
  onOpen: () => void;
  onOpenMenu: (position: { x: number; y: number }) => void;
}) {
  const interactions = useConversationRowInteractions({ onOpen, onOpenMenu });
  return (
    <button
      type="button"
      role={role}
      className={className}
      {...interactions}
    >
      {children}
    </button>
  );
}
