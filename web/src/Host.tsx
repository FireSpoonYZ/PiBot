import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowUp,
  AudioLines,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Code2,
  Cpu,
  ExternalLink,
  FolderOpen,
  Globe,
  MessageSquare,
  Mic,
  Monitor,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings,
  Sparkles,
  Square,
  Star,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react';
import {
  BotHost,
  openCenterManagement,
  type BotSoul,
  type HostBot,
  type HostFrameEvent,
  type HostHistoryPage,
  type HostSettings,
  type HostSettingsPayload,
  type HostSnapshot,
  type HostSubmission,
  type HostVoiceEvent,
  type HostVoiceSaveInput,
  type HostVoiceSettings,
} from './native';
import { mobileLocalRequest, onMobileStreamFailure } from './native/tauri-host';
import { ActiveCenter, useCenterConnection } from './native/CenterGate';
import { useDrafts } from '../../desktop/web/src/drafts';
import { PendingPanel } from '../../desktop/web/src/PendingPanel';
import { readHistoryPage } from '../../desktop/web/src/history';
import { Scopes } from '../../desktop/web/src/Scopes';
import { targetApi } from '../../desktop/web/src/targetApi';
import type { RoomApiResolver } from '../../desktop/web/src/scope-api';
import {
  ConversationContextMenu,
  ConversationGroupAvatar,
  ConversationRow,
  conversationTitle,
  useConversationRowInteractions,
  useScopeConversations,
  type ConversationBot,
  type ScopeConversation,
  type ScopeConversationSource,
} from './gbot-ui';
import { useChatPins } from './gbot-ui/chatPins';
import { SortablePinnedChat } from './gbot-ui/SortablePinnedChat';
import type { MessageMember } from '../../host-core/index.js';
import { createLocalScopeReadApi } from './local-scope-api';
import { MessageAttribution } from './MessageAttribution';
import './bot-communications-mobile.css';
import type { DesktopDraftEntry, DesktopIdentity, DesktopPanelApi } from '../../desktop/web/src/types';
import type { DesktopConnectionInput, DesktopUiProfile } from '../../host-core/desktop-client.js';
import type { BotLiveState, ClearHistoryResult, CompactResult, DevicesDirectoryItem, PendingCursor, PendingListPage, ScopeInfo, ShowerTarget } from '../../host-core/index.js';
import type { ShowerCall } from './ShowerPreview';
import { Markdown } from './Markdown';
import { BotScreenPanel } from './BotScreenPanel';
import { BotModelSheet, type BotSettingsTab } from './BotModelSheet';
import {
  GROK_AVATAR_PRESETS,
  GROK_COLOR_PALETTE,
  GROK_EXPRESSION_LIST,
  GROK_SHAPE_ORDER,
  GrokBotAvatar,
  GrokBotWorkingSlot,
  JARVIS_AVATAR_PRESET,
  getDefaultBotAvatarPreset,
  resolveBotAvatarPreset,
  saveBotAvatarConfig,
  type GrokAvatarPreset,
} from './GrokBotAvatar';
import { botAvatarKey, saveCentralBotAvatar, syncBotAvatarConfigs } from './botAvatarSync';
import {
  canStopBotActivity,
  isBotActivityBusy,
  resolveBotActivity,
  type BotActivity,
} from './botActivity';
import {
  formatTurnDuration,
  latestEntryChannel,
  parseHistoryEntries,
  resolveActiveTurnStartedAt,
  type ChatToolCallItem,
} from './chatTurnModel';
import {
  readToolPresentation,
  ToolPresentationCard,
  type QuestionnaireSubmitPayload,
} from './ToolPresentation';
import {
  IMAGE_MAX_COUNT,
  IMAGE_MAX_TOTAL_BYTES,
  ImageAttachmentThumb,
  ImagePickError,
  SentAttachments,
  attachmentFileName,
  attachmentIdOf,
  normalizeImageFile,
  pickImagesFromInput,
  type AttachmentFetcher,
  type ImageAttachmentData,
  type PickedImageSource,
} from './imageAttachments';
import type { ImageAttachment } from '../../host-core/index.js';
import { ErrorNotice, FloatingPillToast, array, errorText, record, useAction, useText } from './ui';

const uuid = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const V5_CLEANUP_KEY = 'bot-hub-v5-cleaned';
const BOT_META_CACHE_KEY = 'bot-hub-bot-meta-v2';
const BOT_CLEAR_MAP_KEY = 'bot-hub-cleared-v1';
const REMOTE_PROFILES_FLAG_KEY = 'bot-hub-has-remote-v1';
const REMOTE_BOTS_CACHE_KEY = 'bot-hub-remote-bots-cache-v1';
const REMOTE_DEVICES_CACHE_KEY = 'bot-hub-remote-devices-cache-v1';
const PRIMARY_ROLE_OVERRIDE_KEY = 'bot-hub-primary-name-v2';
const DEFAULT_PRIMARY_ROLE = '主助手';
const CREATE_ATTEMPT_KEY = 'bot-hub-create-attempt-v1';
const ARCHIVE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

try {
  if (typeof window !== 'undefined' && window.localStorage.getItem(V5_CLEANUP_KEY) !== '1') {
    window.localStorage.removeItem(BOT_META_CACHE_KEY);
    window.localStorage.removeItem(BOT_CLEAR_MAP_KEY);
    window.localStorage.removeItem(PRIMARY_ROLE_OVERRIDE_KEY);
    window.localStorage.removeItem('bot-hub-primary-role-v1');
    window.localStorage.removeItem(CREATE_ATTEMPT_KEY);
    window.localStorage.removeItem(REMOTE_BOTS_CACHE_KEY);
    window.localStorage.removeItem(REMOTE_DEVICES_CACHE_KEY);
    window.localStorage.setItem(V5_CLEANUP_KEY, '1');
  }
} catch {
  // Ignore storage errors
}

const SOUL_MAX_BYTES = 65536;
const SOUL_SNIPPETS: { zh: string; en: string; text: string }[] = [
  {
    zh: '＋ 角色使命',
    en: '+ Mission',
    text: '\n## 核心角色与使命\n你是一个专注、可靠的 AI 工程与知识助手，优先给出可验证的结论与清晰步骤。\n',
  },
  {
    zh: '＋ 沟通风格',
    en: '+ Style',
    text: '\n## 沟通风格\n- 保持极简与直接，拒绝空洞套话\n- 复杂问题先给结论，再展开关键依据\n',
  },
  {
    zh: '＋ 群聊准则',
    en: '+ Room Rules',
    text: '\n## 协作准则\n- 仅在掌握关键上下文时主动给出结构化建议\n',
  },
];

export type HubScreen =
  | 'hub'
  | 'chat'
  | 'conversation'
  | 'dm'
  | 'bot-profile'
  | 'bot-edit'
  | 'bot-avatar'
  | 'bot-soul'
  | 'bot-schedules'
  | 'bot-screen'
  | 'bot-model'
  | 'settings'
  | 'archived-bots'
  | 'pending';

interface RoomDeleteAttempt {
  scopeId: string;
  title: string;
  authorityDeviceId: string;
  requestId: string;
  expectedRevision: number;
  sessionKey: string;
  unconfirmed: boolean;
}

interface RoomDeleteModalState {
  room: ScopeConversation;
  loadingLatest: boolean;
  submitting: boolean;
  attempt: RoomDeleteAttempt | null;
  error: string;
  conflictNeedReload: boolean;
}

interface BotConfirmModalState {
  kind: 'archive' | 'delete';
  bot: UnifiedBotItem;
}

export interface UnifiedBotItem {
  /** Unique composite key: `${hostKind}:${hostId}:${botId}` */
  key: string;
  deviceId: string;
  botId: string;
  primaryConversationId?: string;
  role: string;
  description?: string;
  cwd: string;
  /** Center CAS revision for the authoritative cwd (absent for local-only records). */
  cwdRevision?: number;
  modelRef: string | null;
  createdAt: string;
  lastActivityAt?: string;
  lastPreview?: string;
  archivedAt?: string | null;
  hostKind: 'local' | 'remote';
  hostId: string;
  hostLabel: string;
  platform?: string;
  online?: boolean;
  isPrimary?: boolean;
  remoteIdentity?: DesktopIdentity;
}

function normalizePlatformKind(platform?: string): 'android' | 'windows' | 'linux' | 'other' {
  const p = (platform ?? '').toLowerCase();
  if (p.includes('android')) return 'android';
  if (p.includes('win')) return 'windows';
  if (p.includes('linux') || p.includes('ubuntu') || p.includes('debian') || p.includes('arch')) return 'linux';
  return 'other';
}

function PlatformLogoIcon({ platform, size = 12 }: { platform?: string; size?: number }) {
  const kind = normalizePlatformKind(platform);
  if (kind === 'android') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        className="platform-logo-icon is-android"
        aria-label="Android"
      >
        <path d="M17.523 15.341a1.003 1.003 0 0 1-1.002-1.002c0-.553.45-1.002 1.002-1.002.553 0 1.002.45 1.002 1.002 0 .553-.449 1.002-1.002 1.002m-11.046 0a1.003 1.003 0 0 1-1.002-1.002c0-.553.45-1.002 1.002-1.002.553 0 1.002.45 1.002 1.002 0 .553-.449 1.002-1.002 1.002m11.405-6.02 1.997-3.46a.416.416 0 0 0-.152-.567.416.416 0 0 0-.568.152L17.137 8.95c-1.547-.704-3.28-1.097-5.137-1.097-1.857 0-3.59.393-5.137 1.097L4.841 5.446a.416.416 0 0 0-.568-.152.416.416 0 0 0-.152.567l1.997 3.46C2.688 11.186.343 14.658 0 18.761h24c-.343-4.103-2.688-7.575-6.118-9.44" />
      </svg>
    );
  }
  if (kind === 'windows') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        className="platform-logo-icon is-windows"
        aria-label="Windows"
      >
        <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
      </svg>
    );
  }
  if (kind === 'linux') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        className="platform-logo-icon is-linux"
        aria-label="Linux"
      >
        <path d="M12 2C9.24 2 7 4.24 7 7v4.27c-1.21 1.48-2 3.32-2 5.23 0 2.76 2.24 5.5 7 5.5s7-2.74 7-5.5c0-1.91-.79-3.75-2-5.23V7c0-2.76-2.24-5-5-5zm-2 4.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zm4 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zM12 10c1.38 0 2.5.67 2.5 1.5S13.38 13 12 13s-2.5-.67-2.5-1.5S10.62 10 12 10zm0 4.5c2.21 0 4 1.34 4 3s-1.79 3-4 3-4-1.34-4-3 1.79-3 4-3z" />
      </svg>
    );
  }
  return <Server size={size} className="platform-logo-icon is-generic" aria-hidden="true" />;
}

interface BotPreviewMeta {
  lastText: string;
  updatedAt: number;
  unread: boolean;
  subtitle?: string;
  customName?: string;
  notifyEnabled?: boolean;
  voiceTone?: string;
  voiceSpeed?: string;
  voiceLang?: string;
  hindsightTopic?: string;
  scheduleCount?: number;
  modelOverride?: string;
}

export type BotScheduleRepeat =
  | 'once'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'statutoryWorkday'
  | 'statutoryHoliday';

export interface BotScheduleLatestRun {
  status: string;
  submissionStatus?: string;
  occurrence: number;
  finishedAt?: number;
}

export interface BotScheduleTask {
  id: string;
  revision: number;
  enabled: boolean;
  title: string;
  prompt?: string;
  repeat: BotScheduleRepeat;
  time: string;
  weekday?: number;
  weekdays?: number[];
  monthDay?: number;
  alarmMode?: 'alarmClock' | 'exact';
  vibrate?: boolean;
  deleteAfterRun?: boolean;
  nextRunAt: number;
  latestRun?: BotScheduleLatestRun | null;
}

export interface BotScheduleState {
  tasks: BotScheduleTask[];
  exactAlarmGranted: boolean;
  schedulingError: string;
  timeZone: string;
  now: number;
}

export interface BotScheduleDraft {
  id?: string;
  revision?: number;
  title: string;
  prompt: string;
  repeat: BotScheduleRepeat;
  time: string;
  weekdays: number[];
  monthDay: number;
  alarmMode: 'alarmClock' | 'exact';
  vibrate: boolean;
  deleteAfterRun: boolean;
}

const WEEKDAY_SHORT_ZH = ['一', '二', '三', '四', '五', '六', '日'];
const WEEKDAY_SHORT_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function formatScheduleRepeatLabel(
  task: Pick<BotScheduleTask, 'repeat' | 'weekday' | 'weekdays' | 'monthDay'>,
  t: (zh: string, en: string) => string,
): string {
  if (task.repeat === 'once') return t('单次执行', 'Once');
  if (task.repeat === 'daily') return t('每天', 'Every day');
  if (task.repeat === 'statutoryWorkday') return t('法定工作日', 'Workdays');
  if (task.repeat === 'statutoryHoliday') return t('法定节假日', 'Holidays');
  if (task.repeat === 'monthly') {
    const day = task.monthDay ?? 1;
    return t(`每月 ${day} 日`, `Day ${day} monthly`);
  }
  if (task.repeat === 'weekly') {
    const days = (task.weekdays && task.weekdays.length > 0 ? task.weekdays : [task.weekday ?? 1])
      .slice()
      .sort((a, b) => a - b);
    if (days.join(',') === '1,2,3,4,5') return t('周一至周五', 'Mon–Fri');
    if (days.join(',') === '6,7') return t('周六日', 'Weekends');
    if (days.length === 7) return t('每天', 'Every day');
    return t(
      `每周 ${days.map(d => WEEKDAY_SHORT_ZH[(d - 1) % 7]).join('、')}`,
      `Weekly ${days.map(d => WEEKDAY_SHORT_EN[(d - 1) % 7]).join(', ')}`,
    );
  }
  return t('每天', 'Every day');
}

function formatScheduleNextRun(
  nextRunAt: number,
  timeZone: string,
  t: (zh: string, en: string) => string,
): string {
  if (!nextRunAt || nextRunAt <= 0) return t('未计划', 'Not scheduled');
  try {
    return new Intl.DateTimeFormat(t('zh-CN', 'en-US'), {
      timeZone: timeZone || undefined,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(nextRunAt);
  } catch {
    return new Date(nextRunAt).toLocaleString();
  }
}

/** Host 按轮同步受理状态；协议 lane 未补共享类型前本地只读可选字段。 */
interface TurnAdmissionStatus {
  requestId: string;
  phase: 'queued' | 'checking' | 'synchronizing' | 'failed';
  error?: { code: string; message: string };
}
type TurnAdmissionCarrier = { admission?: TurnAdmissionStatus | null };

interface ChatPending {
  botKey: string;
  scopeKey: string;
  requestId: string;
  text: string;
  /** 已上传图片附件 ID（有序）；图片-only 提交时 text 可为空。 */
  attachments?: string[];
  afterEntryId: number;
  submittedAt?: number;
  pendingId?: string;
  draft?: DesktopDraftEntry;
  admission?: TurnAdmissionStatus | null;
  phase: 'sending' | 'recovering' | 'accepted';
}
interface ChatPendingEntry { pending: ChatPending; receipt?: HostSubmission & TurnAdmissionCarrier }

function chatStorageKey(center: string, deviceId: string, botId: string): string {
  return `bot-chat-v1:${JSON.stringify([center, deviceId, botId])}`;
}
function readChatPending(key: string): ChatPendingEntry | undefined {
  try {
    const entry = JSON.parse(localStorage.getItem(`${key}:pending`) || 'null') as ChatPendingEntry | null;
    if (!entry?.pending?.requestId || entry.pending.scopeKey !== key) return undefined;
    return { ...entry, pending: { ...entry.pending, phase: entry.receipt ? 'accepted' : 'recovering' } };
  } catch { return undefined; }
}
function readChatDraft(key: string): string {
  try { return localStorage.getItem(`${key}:draft`) || ''; } catch { return ''; }
}
function writeChatDraft(key: string, text: string): boolean {
  try { if (text) localStorage.setItem(`${key}:draft`, text); else localStorage.removeItem(`${key}:draft`); return true; }
  catch { return false; }
}

/** 本机草稿附件引用只存 ImageAttachment 元数据；base64 绝不进 localStorage/pending。 */
function readChatDraftAttachments(key: string): ImageAttachment[] {
  try {
    const raw = localStorage.getItem(`${key}:draft-attachments`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ImageAttachment[] = [];
    for (const item of parsed) {
      const att = item as Record<string, unknown> | null;
      if (!att || typeof att.id !== 'string' || !att.id) continue;
      const mime = att.mimeType === 'image/jpeg' || att.mimeType === 'image/png' ? att.mimeType : 'image/jpeg';
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      out.push({
        id: att.id,
        name: typeof att.name === 'string' ? att.name : '',
        mimeType: mime,
        size: num(att.size),
        width: num(att.width),
        height: num(att.height),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function writeChatDraftAttachments(key: string, attachments: ImageAttachment[]): boolean {
  try {
    if (attachments.length) localStorage.setItem(`${key}:draft-attachments`, JSON.stringify(attachments));
    else localStorage.removeItem(`${key}:draft-attachments`);
    return true;
  } catch {
    return false;
  }
}

function readBotMetaMap(): Record<string, BotPreviewMeta> {
  try {
    const raw = window.localStorage.getItem(BOT_META_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, BotPreviewMeta>) : {};
  } catch {
    return {};
  }
}

function writeBotMetaMap(map: Record<string, BotPreviewMeta>): void {
  try {
    window.localStorage.setItem(BOT_META_CACHE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

function readClearedMap(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(BOT_CLEAR_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeClearedMap(map: Record<string, number>): void {
  try {
    window.localStorage.setItem(BOT_CLEAR_MAP_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

function readHasRemoteFlag(): boolean {
  try {
    return window.localStorage.getItem(REMOTE_PROFILES_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHasRemoteFlag(hasRemote: boolean): void {
  try {
    if (hasRemote) window.localStorage.setItem(REMOTE_PROFILES_FLAG_KEY, '1');
    else window.localStorage.removeItem(REMOTE_PROFILES_FLAG_KEY);
  } catch {
    // Ignore storage errors
  }
}

type CachedRemoteBot = HostBot & { deviceName: string; platform?: string; description?: string };

function readCachedRemoteBots(): CachedRemoteBot[] {
  try {
    const raw = window.localStorage.getItem(REMOTE_BOTS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CachedRemoteBot[]) : [];
  } catch {
    return [];
  }
}

function writeCachedRemoteBots(bots: CachedRemoteBot[]): void {
  try {
    window.localStorage.setItem(REMOTE_BOTS_CACHE_KEY, JSON.stringify(bots));
  } catch {
    // Ignore storage errors
  }
}

function readCachedRemoteDevices(): DevicesDirectoryItem[] {
  try {
    const raw = window.localStorage.getItem(REMOTE_DEVICES_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DevicesDirectoryItem[]) : [];
  } catch {
    return [];
  }
}

function writeCachedRemoteDevices(devices: DevicesDirectoryItem[]): void {
  try {
    window.localStorage.setItem(REMOTE_DEVICES_CACHE_KEY, JSON.stringify(devices));
  } catch {
    // Ignore storage errors
  }
}

function formatArchivedRemainingDays(archivedAt: string | null | undefined): number {
  if (!archivedAt) return 14;
  const archivedMs = Date.parse(archivedAt);
  if (!Number.isFinite(archivedMs)) return 14;
  const remainingMs = archivedMs + ARCHIVE_RETENTION_MS - Date.now();
  return Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
}

async function fetchBotHistoryPages(
  fetchPage: (cursor: Record<string, unknown> | null, limit: number, chunked: boolean) => Promise<HostHistoryPage | null>,
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  let cursor: Record<string, unknown> | null = null;
  for (;;) {
    const page = await readHistoryPage(fetchPage, cursor, 200);
    const items = array<Record<string, unknown>>(page?.items);
    if (items.length > 0) all.push(...items);
    const next = page?.nextCursor;
    if (!next || typeof next !== 'object' || Array.isArray(next) || items.length === 0) break;
    cursor = next as Record<string, unknown>;
  }
  return all;
}

function mergeHistory(previous: Array<Record<string, unknown>>, next: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const items = new Map(previous.map(item => [String(item.id), item]));
  for (const item of next) items.set(String(item.id), item);
  return [...items.values()];
}

function maxHistoryEntryId(items: Array<Record<string, unknown>>): number {
  let max = 0;
  for (const item of items) {
    const id = typeof item.id === 'number' ? item.id : Number(item.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max;
}

// 聊天 slash 命令：只有 /clear 与 /compact；执行全部走后端控制方法，不经过模型 submit。
function formatToolStepDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  if (safe < 1000) return `${safe}ms`;
  if (safe < 10_000) {
    const sec = Math.round(safe / 100) / 10;
    return Number.isInteger(sec) ? `${sec}s` : `${sec.toFixed(1)}s`;
  }
  const totalSec = Math.round(safe / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return secs > 0 ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${mins}m`;
}

function copyTextToClipboard(value: string): void {
  if (!value) return;
  try {
    void navigator.clipboard?.writeText(value);
  } catch {
    // Ignore clipboard permission errors in webview
  }
}

function renderToolStepIcon(status: ChatToolCallItem['status']) {
  if (status === 'running') {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeOpacity="0.24" strokeWidth="1.75" />
        <path d="M8 2.25A5.75 5.75 0 0 1 13.75 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 5v3.5M8 11h.01" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none">
      <path
        d="M3.75 8.25 6.6 11.1 12.25 5.25"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function extractSmartArgEntries(
  toolName: string,
  args?: Record<string, unknown>,
): Array<{ label: string; value: string; mono?: boolean }> {
  if (!args) return [];
  const lower = toolName.toLowerCase();
  const entries: Array<{ label: string; value: string; mono?: boolean }> = [];
  const addStr = (key: string, label: string, mono = true) => {
    const val = args[key];
    if (typeof val === 'string' && val.trim()) {
      entries.push({ label, value: val.trim(), mono });
    }
  };

  if (lower === 'bash' || lower.endsWith('_bash') || lower === 'shell' || lower === 'exec') {
    addStr('command', '$');
    addStr('cmd', '$');
    if (typeof args.timeout === 'number') {
      entries.push({ label: 'timeout', value: `${args.timeout}s`, mono: true });
    }
    return entries;
  }

  if (lower === 'read' || lower === 'write' || lower === 'edit' || lower === 'lsp_fix') {
    addStr('path', 'path');
    addStr('file_path', 'path');
    addStr('filePath', 'path');
    if (typeof args.offset === 'number' || typeof args.limit === 'number') {
      const range = [
        typeof args.offset === 'number' ? `offset=${args.offset}` : '',
        typeof args.limit === 'number' ? `limit=${args.limit}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      if (range) entries.push({ label: 'range', value: range, mono: true });
    }
    if (Array.isArray(args.edits)) {
      entries.push({ label: 'edits', value: `${args.edits.length} block(s)`, mono: true });
    }
    return entries;
  }

  if (lower === 'grep' || lower === 'find' || lower === 'ls' || lower === 'search') {
    addStr('pattern', 'pattern');
    addStr('query', 'query');
    addStr('path', 'path');
    addStr('glob', 'glob');
    return entries;
  }

  if (lower === 'codemode') {
    addStr('code', 'script');
    return entries;
  }

  for (const [k, v] of Object.entries(args)) {
    if (entries.length >= 4) break;
    if (typeof v === 'string' && v.trim()) {
      entries.push({ label: k, value: v.trim(), mono: true });
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      entries.push({ label: k, value: String(v), mono: true });
    }
  }
  return entries;
}

function ToolCallStepCard({
  tool,
  botKey,
  isBotBusy,
  disabled,
  onSubmitQuestionnaire,
  t,
}: {
  tool: ChatToolCallItem;
  botKey: string;
  isBotBusy: boolean;
  disabled: boolean;
  onSubmitQuestionnaire: (presentation: { installationId: string }, input: QuestionnaireSubmitPayload) => Promise<unknown>;
  t: (zh: string, en: string) => string;
}) {
  const [expanded, setExpanded] = useState(() => tool.status === 'error');
  const [showRawJson, setShowRawJson] = useState(false);
  const [copiedPart, setCopiedPart] = useState<'args' | 'output' | null>(null);

  const presentation = tool.presentation ? readToolPresentation(tool.presentation) : null;
  const hasArgs = Boolean(tool.args && Object.keys(tool.args).length > 0);
  const hasOutput = Boolean(tool.output && tool.output.trim());
  const smartEntries = useMemo(() => extractSmartArgEntries(tool.name, tool.args), [tool.name, tool.args]);
  const rawArgsJson = useMemo(
    () => (hasArgs ? JSON.stringify(tool.args, null, 2) : ''),
    [hasArgs, tool.args],
  );

  const stateLabel =
    tool.status === 'running'
      ? t('调用中', 'Calling')
      : tool.status === 'error'
        ? t('失败', 'Failed')
        : typeof tool.durationMs === 'number' && tool.durationMs > 0
          ? formatToolStepDuration(tool.durationMs)
          : t('已完成', 'Done');

  const triggerCopy = (part: 'args' | 'output', text: string) => {
    copyTextToClipboard(text);
    setCopiedPart(part);
    window.setTimeout(() => {
      setCopiedPart(current => (current === part ? null : current));
    }, 1400);
  };

  return (
    <div role="listitem" className="bot-chat-tool-wrap">
      <button
        type="button"
        className={`bot-chat-tool-chip is-${tool.status}${expanded ? ' is-expanded' : ''}`}
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
      >
        <span className="bot-tool-step-icon" aria-hidden="true">
          {renderToolStepIcon(tool.status)}
        </span>
        <span className="bot-tool-step-name">{tool.name}</span>
        {tool.argSummary ? (
          <span className="bot-tool-step-summary" title={tool.argSummary}>
            {tool.argSummary}
          </span>
        ) : null}
        <span className="bot-tool-step-state">{stateLabel}</span>
        <ChevronDown size={13} className={`bot-tool-step-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true" />
      </button>

      {expanded && (
        <div className={`bot-tool-detail-panel is-${tool.status}`} role="region" aria-label={`${tool.name} ${t('调用详情', 'Call details')}`}>
          {hasArgs ? (
            <div className="bot-tool-detail-section">
              <div className="bot-tool-detail-head">
                <span className="bot-tool-detail-label">{t('参数', 'ARGS')}</span>
                <div className="bot-tool-detail-actions">
                  {smartEntries.length > 0 && (
                    <button
                      type="button"
                      className="bot-tool-detail-mini-btn"
                      onClick={() => setShowRawJson(v => !v)}
                    >
                      {showRawJson ? t('智能摘要', 'Summary') : t('原始 JSON', 'Raw JSON')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="bot-tool-detail-mini-btn"
                    onClick={() => triggerCopy('args', rawArgsJson)}
                  >
                    {copiedPart === 'args' ? t('已复制', 'Copied') : t('复制', 'Copy')}
                  </button>
                </div>
              </div>
              {!showRawJson && smartEntries.length > 0 ? (
                <div className="bot-tool-smart-args">
                  {smartEntries.map((entry, idx) => (
                    <div key={idx} className="bot-tool-smart-row">
                      <span className="bot-tool-smart-key">{entry.label}</span>
                      <code className="bot-tool-smart-val">{entry.value}</code>
                    </div>
                  ))}
                </div>
              ) : (
                <pre className="bot-tool-detail-pre">{rawArgsJson}</pre>
              )}
            </div>
          ) : null}

          {hasOutput ? (
            <div className="bot-tool-detail-section">
              <div className="bot-tool-detail-head">
                <span className="bot-tool-detail-label">
                  {tool.status === 'error'
                    ? t('错误输出', 'ERROR')
                    : tool.status === 'running'
                      ? t('实时输出', 'LIVE OUTPUT')
                      : t('输出', 'RESULT')}
                  {tool.outputTruncated ? ` · ${t('已截断', 'Truncated')}` : ''}
                </span>
                <div className="bot-tool-detail-actions">
                  <button
                    type="button"
                    className="bot-tool-detail-mini-btn"
                    onClick={() => triggerCopy('output', tool.output ?? '')}
                  >
                    {copiedPart === 'output' ? t('已复制', 'Copied') : t('复制', 'Copy')}
                  </button>
                </div>
              </div>
              <pre className="bot-tool-detail-pre is-output">{tool.output}</pre>
            </div>
          ) : null}

          {!hasArgs && !hasOutput ? (
            <div className="bot-tool-detail-empty">
              {tool.status === 'running'
                ? t('正在执行工具，等待输出返回…', 'Running tool, waiting for output…')
                : t('该工具调用已执行完成（无额外参数或文本输出）', 'Completed with no additional text output')}
            </div>
          ) : null}
        </div>
      )}

      {presentation ? (
        <ToolPresentationCard
          key={`${botKey}:${presentation.kind === 'questionnaire' ? presentation.requestId : tool.id}`}
          presentation={presentation}
          active={tool.presentationLive === true && isBotBusy}
          disabled={disabled}
          onSubmit={
            presentation.kind === 'questionnaire'
              ? input => onSubmitQuestionnaire(presentation, input)
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

function TurnToolCallsSection({
  tools,
  botKey,
  isBotBusy,
  disabled,
  onSubmitQuestionnaire,
  t,
}: {
  tools: ChatToolCallItem[];
  botKey: string;
  isBotBusy: boolean;
  disabled: boolean;
  onSubmitQuestionnaire: (presentation: { installationId: string }, input: QuestionnaireSubmitPayload) => Promise<unknown>;
  t: (zh: string, en: string) => string;
}) {
  const hasActiveOrErrorOrInteractive = tools.some(
    tool =>
      tool.status === 'running' ||
      tool.status === 'error' ||
      Boolean(tool.presentation && readToolPresentation(tool.presentation)),
  );
  const shouldAggregate = tools.length >= 3;
  const [groupOpen, setGroupOpen] = useState(() => !shouldAggregate || hasActiveOrErrorOrInteractive);

  useEffect(() => {
    if (hasActiveOrErrorOrInteractive) {
      setGroupOpen(true);
    }
  }, [hasActiveOrErrorOrInteractive]);

  const totalDurationMs = useMemo(
    () => tools.reduce((sum, item) => sum + (typeof item.durationMs === 'number' && item.durationMs > 0 ? item.durationMs : 0), 0),
    [tools],
  );
  const runningTool = tools.find(item => item.status === 'running');
  const errorCount = tools.filter(item => item.status === 'error').length;

  if (!shouldAggregate) {
    return (
      <div className="bot-chat-tools" role="list" aria-label={t('工具调用', 'Tool calls')}>
        {tools.map(tool => (
          <ToolCallStepCard
            key={tool.id}
            tool={tool}
            botKey={botKey}
            isBotBusy={isBotBusy}
            disabled={disabled}
            onSubmitQuestionnaire={onSubmitQuestionnaire}
            t={t}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="bot-chat-tools-group">
      <button
        type="button"
        className={`bot-chat-tools-group-bar${runningTool ? ' is-running' : errorCount > 0 ? ' is-error' : ''}`}
        aria-expanded={groupOpen}
        onClick={() => setGroupOpen(v => !v)}
      >
        <span className="bot-tool-step-icon" aria-hidden="true">
          {renderToolStepIcon(runningTool ? 'running' : errorCount > 0 ? 'error' : 'done')}
        </span>
        <span className="bot-tools-group-title">
          {runningTool
            ? t(`正在调用 ${runningTool.name} (${tools.length} 个工具)`, `Running ${runningTool.name} (${tools.length} tools)`)
            : t(`已使用 ${tools.length} 个工具`, `Used ${tools.length} tools`)}
        </span>
        {totalDurationMs > 0 && !runningTool ? (
          <span className="bot-tools-group-meta">
            {t(`耗时 ${formatToolStepDuration(totalDurationMs)}`, formatToolStepDuration(totalDurationMs))}
          </span>
        ) : null}
        {errorCount > 0 ? (
          <span className="bot-tools-group-error">
            {t(`${errorCount} 失败`, `${errorCount} failed`)}
          </span>
        ) : null}
        <ChevronDown size={14} className={`bot-tool-step-chevron${groupOpen ? ' is-open' : ''}`} aria-hidden="true" />
      </button>

      {groupOpen && (
        <div className="bot-chat-tools is-grouped" role="list" aria-label={t('工具调用', 'Tool calls')}>
          {tools.map(tool => (
            <ToolCallStepCard
              key={tool.id}
              tool={tool}
              botKey={botKey}
              isBotBusy={isBotBusy}
              disabled={disabled}
              onSubmitQuestionnaire={onSubmitQuestionnaire}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const SLASH_COMMANDS = [
  { name: '/clear', zh: '清空当前对话并重置模型上下文', en: 'Clear history and reset model context' },
  { name: '/compact', zh: '压缩较早的上下文', en: 'Compact earlier context' },
] as const;
type SlashCommandName = (typeof SLASH_COMMANDS)[number]['name'];

function slashMatches(text: string) {
  return text.startsWith('/') && !/\s/.test(text)
    ? SLASH_COMMANDS.filter(command => command.name.startsWith(text))
    : [];
}

function parseSlashCommand(text: string): SlashCommandName | undefined {
  const trimmed = text.trim();
  return SLASH_COMMANDS.find(command => command.name === trimmed)?.name;
}

/**
 * 两处输入框共用的 slash 补全：仅整段输入为 / 或命令前缀时出现，按前缀筛选；↑↓ 选择，Tab/点击只补全，
 * Enter 在未完整匹配时补全、已输入完整命令时执行，Esc 隐藏至输入再次变化；Shift+Enter 与 IME 不触发。
 * 补全只写调用方给的现有草稿路径。
 */
function useSlashAutocomplete({ text, disabled, onText, onRun }: {
  text: string;
  disabled: boolean;
  onText(text: string): void;
  onRun(command: SlashCommandName): void;
}) {
  const listboxId = useId();
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const matches = slashMatches(text);
  const open = !disabled && matches.length > 0 && dismissed !== text;
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));
  // 输入一变就清掉 Esc 的隐藏标记与选中项：/ → Esc → /c → / 应重新展开。
  useEffect(() => { setActive(0); setDismissed(null); }, [text]);
  const choose = (index: number) => {
    const command = matches[index];
    if (command) onText(command.name);
  };
  // true 表示已消费该按键，调用方不再执行原有发送逻辑。
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(previous => (previous + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(text);
      return true;
    }
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      choose(activeIndex);
      return true;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (matches.some(command => command.name === text)) onRun(text as SlashCommandName);
      else choose(activeIndex);
      return true;
    }
    return false;
  };
  const textareaProps = {
    'aria-autocomplete': 'list' as const,
    'aria-controls': open ? listboxId : undefined,
    'aria-expanded': open,
    'aria-activedescendant': open ? `${listboxId}-${activeIndex}` : undefined,
  };
  const optionProps = (index: number) => ({
    id: `${listboxId}-${index}`,
    role: 'option' as const,
    'aria-selected': index === activeIndex,
    // 不抢 textarea 焦点：点击补全后输入框仍保持聚焦。
    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
    onClick: () => choose(index),
    onMouseEnter: () => setActive(index),
  });
  return { open, matches, activeIndex, listboxId, textareaProps, optionProps, onKeyDown };
}

const soulBytes = (text: string): number => {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
};

function parseBotSoul(value: unknown): BotSoul | undefined {
  const raw = record(value);
  return typeof raw.botId === 'string' &&
    typeof raw.path === 'string' &&
    typeof raw.revision === 'string' &&
    typeof raw.text === 'string'
    ? { botId: raw.botId, path: raw.path, revision: raw.revision, text: raw.text }
    : undefined;
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
  const action = useAction();
  const activeCenter = useContext(ActiveCenter);
  const centerConn = useCenterConnection();
  const centerConnectionRef = useRef(centerConn);
  centerConnectionRef.current = centerConn;

  // Screen stack navigation
  const [screen, setScreen] = useState<HubScreen>('hub');
  const [chatReturnScreen, setChatReturnScreen] = useState<'hub' | 'archived-bots'>('hub');
  const [profileReturnScreen, setProfileReturnScreen] = useState<HubScreen>('chat');
  const [avatarReturnScreen, setAvatarReturnScreen] = useState<HubScreen>('bot-edit');
  const [subPageReturnScreen, setSubPageReturnScreen] = useState<HubScreen>('bot-profile');

  // Left drawer (always mounted in DOM for smooth slide-in & slide-out animation)
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);

  // Hub search
  const [searchQuery, setSearchQuery] = useState('');

  // Hub 群聊 / Bot 长按·右键·键盘上下文菜单与目标。
  const [hubContextMenu, setHubContextMenu] = useState<{
    x: number;
    y: number;
    bot?: UnifiedBotItem;
    room?: ScopeConversation;
  } | null>(null);
  // 群聊/私聊子页：目标 conversation + 打开来源（hub 或 chat），返回时还原；roomSettingsOpen 控制群详情设置面板。
  const [scopeConversationTarget, setScopeConversationTarget] = useState<ScopeConversation | null>(null);
  const [scopeReturnScreen, setScopeReturnScreen] = useState<HubScreen>('hub');
  const [roomSettingsOpen, setRoomSettingsOpen] = useState(false);
  const [dmTarget, setDmTarget] = useState<{ bot: UnifiedBotItem; returnScreen: HubScreen } | null>(null);
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
  const localBotsGeneration = useRef(0);
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
  const [createAttempt, setCreateAttemptState] = useState<{ requestId: string; target: string; profileId?: string } | null>(() => {
    try { return JSON.parse(localStorage.getItem(CREATE_ATTEMPT_KEY) || 'null'); } catch { return null; }
  });
  const setCreateAttempt = (attempt: { requestId: string; target: string; profileId?: string } | null) => {
    if (attempt) localStorage.setItem(CREATE_ATTEMPT_KEY, JSON.stringify(attempt));
    else localStorage.removeItem(CREATE_ATTEMPT_KEY);
    setCreateAttemptState(attempt);
  };
  const [remoteDevices, setRemoteDevices] = useState<DevicesDirectoryItem[]>(() => readCachedRemoteDevices());
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
  const [avatarVersion, setAvatarVersion] = useState(0);

  // Active Bot & Chat state
  const [activeBotKey, setActiveBotKey] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<Array<Record<string, unknown>>>([]);
  // chatLive 保存累计的实时会话状态（BotLiveState），不是原始帧联合：
    // snapshot 全量替换、update 只把 changes 合并进现有快照，end 清空。
    // 字段访问直接读 BotLiveState，真实类型不含 state 包装。
  const [chatLive, setChatLive] = useState<BotLiveState | undefined>();
  const [chatReceipt, setChatReceipt] = useState<HostSubmission>();
  const [chatPending, setChatPending] = useState<ChatPending>();
  const pendingByBot = useRef(new Map<string, ChatPendingEntry>());
  const currentChatScope = useRef('');
  const selectedChatTarget = useRef<{ hostKind: 'local' | 'remote'; hostId: string; botId: string } | undefined>(undefined);
  const localInFlight = useRef(new Set<string>());
  const [chatObservationError, setChatObservationError] = useState('');
  // 历史读取失败单独记录：观察恢复成功只清连接问题，不清掉这次历史错误，交给现有 2s 重试。
  const [chatHistoryError, setChatHistoryError] = useState('');
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
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [clearNotice, setClearNotice] = useState('');
  const [offlineNotice, setOfflineNotice] = useState<{ botKey: string; text: string }>();
  const [voiceCapturing, setVoiceCapturing] = useState<{ botId: string; requestId: string }>();

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


  // Bot Edit / Create mode state (15847.jpg)
  const [editMode, setEditMode] = useState<'create' | 'edit'>('edit');
  const [editMakePrimary, setEditMakePrimary] = useState(false);
  const [editName, setEditName] = useState('');
  const [editSubtitle, setEditSubtitle] = useState('');
  const [editCwd, setEditCwd] = useState('');
  const [editCwdRevision, setEditCwdRevision] = useState<number | null>(null);
  const [editCwdError, setEditCwdError] = useState('');
  // 单调递增 token：编辑目标/连接变化丢弃迟到的 cwd 回填结果。
  const editCwdFetchRef = useRef(0);
  // 用户已编辑目录后，异步回填不得覆盖输入。
  const editCwdDirtyRef = useRef(false);
  const [editTargetHost, setEditTargetHost] = useState('local');
  const [editAvatarPreset, setEditAvatarPreset] = useState<GrokAvatarPreset>(GROK_AVATAR_PRESETS[0]);
  const [editInitialSoul, setEditInitialSoul] = useState('');
  const [editVoiceTone, setEditVoiceTone] = useState('未设置');
  const [editVoiceSpeed, setEditVoiceSpeed] = useState('1x');
  const [editVoiceLang, setEditVoiceLang] = useState('自动');

  // Avatar Picker state (15848.jpg)
  const [avatarTab, setAvatarTab] = useState<'shape' | 'expression'>('shape');
  const [draftAvatar, setDraftAvatar] = useState<GrokAvatarPreset>(GROK_AVATAR_PRESETS[0]);

  // Bot Soul & Extensions state
  const [botSoul, setBotSoul] = useState<BotSoul | null>(null);
  const [soulDraft, setSoulDraft] = useState('');
  const [soulDirty, setSoulDirty] = useState(false);

  // Per-Bot Scheduled Tasks state
  const [botScheduleState, setBotScheduleState] = useState<BotScheduleState>({
    tasks: [],
    exactAlarmGranted: true,
    schedulingError: '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    now: Date.now(),
  });
  const [scheduleFilter, setScheduleFilter] = useState<'all' | 'enabled' | 'paused'>('all');
  const [scheduleEditing, setScheduleEditing] = useState<'new' | 'edit' | null>(null);
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

  const [modelTarget, setModelTarget] = useState<{ botKey: string; botId: string; center: string; identity: DesktopIdentity; api: DesktopPanelApi; tab: BotSettingsTab } | null>(null);

  const observeIdRef = useRef<string | undefined>(undefined);
  const remoteObserveRef = useRef<{ close(): Promise<void> } | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
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

  // Transparently sync local bots
  const syncLocalBots = useCallback(async (snap?: HostSnapshot): Promise<HostBot[]> => {
    const generation = ++localBotsGeneration.current;
    try {
      const currentSnap = snap ?? (await BotHost.snapshot());
      if (generation !== localBotsGeneration.current) return [];
      setLocalHost(currentSnap);
      if (currentSnap.phase !== 'running') {
        setLocalBotsLoaded(false);
        return [];
      }
      if (activeCenter) {
        try {
          const status = await BotHost.status();
          if (status.center?.centerUrl && new URL(status.center.centerUrl).origin !== new URL(activeCenter).origin) {
            setLocalBots([]);
            setLocalBotsLoaded(false);
            return [];
          }
        } catch {
          // Ignore transient status check errors while center is connecting
        }
      }
      const envelope = await BotHost.call({ method: 'listBots', params: {} });
      const list = array<HostBot>(envelope.result);
      if (generation !== localBotsGeneration.current) return [];
      setLocalBots(list);
      try { localStorage.setItem('e-launcher:cached-local-bots-v1', JSON.stringify(list)); } catch { /* ignore */ }
      setLocalBotsLoaded(true);
      return list;
    } catch {
      return [];
    }
  }, [activeCenter]);

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
    let alive = true;
    void (async () => {
      try {
        const snap = await BotHost.snapshot();
        if (!alive) return;
        setLocalHost(snap);
        if (snap.phase === 'running') {
          await syncLocalBots(snap);
        }
      } catch {
        // Ignore cold read error
      }
    })();
    return () => {
      alive = false;
    };
  }, [active, connectionEpoch, syncLocalBots]);

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
      const directory = await api.broker(identity, 'bot_directory', {});
      if (generation !== directoryGeneration.current || api.identity?.generation !== identity.generation) return;
      await syncBotAvatarConfigs(api, directory.bots, localHostRef.current?.deviceId ?? '');
      if (generation !== directoryGeneration.current || api.identity?.generation !== identity.generation) return;
      setRemoteDevices(directory.devices);
      writeCachedRemoteDevices(directory.devices);
      setRemoteBots(previous => {
        const failed = new Set(directory.errors.map(error => error.deviceId));
        for (const device of directory.devices) if (!device.online) failed.add(device.deviceId);
        const returnedKeys = new Set(directory.bots.map(b => `${b.deviceId}:${b.botId}`));
        const merged = [
          ...directory.bots,
          ...previous.filter(bot => failed.has(bot.deviceId) && !returnedKeys.has(`${bot.deviceId}:${bot.botId}`)),
        ];
        writeCachedRemoteBots(merged);
        return merged;
      });
      setDirectoryError(directory.errors.map(error => `${error.deviceId}: ${error.message || error.code}`).join(' · '));
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
    const localByIdentity = new Map(localBots.map(bot => [JSON.stringify([bot.deviceId, bot.botId]), bot] as const));
    for (const bot of remoteBots) {
      if (bot.deviceId !== localHost?.deviceId) continue;
      const key = JSON.stringify([bot.deviceId, bot.botId]);
      if (!localByIdentity.has(key)) localByIdentity.set(key, bot);
    }
    const allLocal: UnifiedBotItem[] = [...localByIdentity.values()].map(b => {
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
        modelRef: b.modelRef,
        createdAt: b.createdAt,
        lastActivityAt: b.lastActivityAt || b.createdAt,
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
    const allRemote: UnifiedBotItem[] = [...remoteByIdentity.values()].map(b => {
      const key = `remote:${activeProfileId}:${b.deviceId}:${b.botId}`;
      const matchedDevice = remoteDevices.find(device => device.deviceId === b.deviceId);
      const isOnline = Boolean(remoteConnected && matchedDevice?.online);
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
        createdAt: b.createdAt,
        lastActivityAt: b.lastActivityAt || b.createdAt,
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

    const getSortTime = (item: UnifiedBotItem): number => {
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

  const activeBot = useMemo<UnifiedBotItem | null>(() => {
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
    loading: roomConversationsLoading,
    error: roomConversationsError,
    refresh: refreshRoomConversations,
  } = useScopeConversations(scopeConversationSources, active && screen === 'hub', 'room');
  // 下拉刷新用最新 refresh：ref 免除把 hook 返回值塞进 triggerHubRefresh 依赖。
  const refreshRoomConversationsRef = useRef(refreshRoomConversations);
  refreshRoomConversationsRef.current = refreshRoomConversations;

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

  const chatPins = useChatPins(pinStorageScope);
  const botPinKey = useCallback((bot: { deviceId: string; botId: string }) => `bot:${bot.deviceId}:${bot.botId}`, []);
  const roomPinKey = useCallback((scopeId: string) => `room:${scopeId}`, []);

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
    setChatTopMenuOpen(false);
    setComposerMenuOpen(false);
    setChatSearchOpen(false);
    setChatSearchQuery('');
    setRoomSettingsOpen(initialSettingsOpen);
    setScopeConversationTarget(item);
    setScopeReturnScreen(screen === 'dm' || screen === 'conversation' ? 'hub' : screen);
    setScreen('conversation');
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
    setDmTarget({ bot, returnScreen: screen === 'dm' ? 'hub' : screen });
    setDmSelectedScopeId(null);
    setScreen('dm');
  };

  // 换账户/档案/代际/本机设备时，已打开的群聊/私聊子页不得残留旧会话内容：
  // 清空目标并回来源页（dm 回其 returnScreen，conversation 回 scopeReturnScreen）。
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
    setBotConfirmModal(null);
    if (screen === 'conversation') setScreen(scopeReturnScreen);
    else if (screen === 'dm') setScreen(dmTarget?.returnScreen ?? 'hub');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeSessionKey]);

  const scopeAccountKey = `${localHost?.deviceId ?? 'nodev'}|${remoteIdentity?.profileId ?? '-'}|${remoteIdentity?.kind ?? '-'}`;
  const scopeAccountRef = useRef(scopeAccountKey);
  useEffect(() => {
    if (scopeAccountRef.current === scopeAccountKey) return;
    scopeAccountRef.current = scopeAccountKey;
    unconfirmedRoomDeletesRef.current.clear();
    setRoomDeleteModal(null);
  }, [scopeAccountKey]);

  const scopeForBot = (bot: UnifiedBotItem) => {
    const deviceId = bot.hostKind === 'local'
      ? localHost?.deviceId || localBots.find(item => item.botId === bot.botId)?.deviceId || ''
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
  const removePending = (scopeKey: string, requestId: string) => {
    const entry = pendingByBot.current.get(scopeKey);
    if (!entry || entry.pending.requestId !== requestId) return;
    pendingByBot.current.delete(scopeKey);
    try { localStorage.removeItem(`${scopeKey}:pending`); } catch { /* retain safe copy */ }
    if (currentChatScope.current === scopeKey) {
      chatSubmissionRef.current = undefined;
      setChatPending(undefined);
      setChatReceipt(undefined);
    }
  };

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

  const unreadCount = useMemo(() => {
    return listBotItems.filter(item => botMetaMap[item.key]?.unread).length;
  }, [listBotItems, botMetaMap]);

  const cancelActiveObservation = useCallback(() => {
    if (observeIdRef.current) {
      const id = observeIdRef.current;
      observeIdRef.current = undefined;
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
          setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…'));
          return;
        }
        const f = ev.frame;
        if (!f) return;
        if (f.type === 'snapshot') {
          setChatLive(f.state);
        } else if (f.type === 'update') {
          // update 只把 changes 合并进已有快照；观察首帧必为 snapshot，update 不单独入栈。
          setChatLive(prev => (prev ? { ...prev, ...f.changes } : prev));
        } else if (f.type === 'end') {
          observeIdRef.current = undefined;
          setChatLive(undefined);
        }
      }),
      BotHost.addListener('voiceEvent', (ev: HostVoiceEvent) => {
        if (!alive) return;
        if (ev.type === 'submitted' || ev.type === 'error') {
          setVoiceCapturing(current => current?.requestId === ev.requestId ? undefined : current);
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

  useEffect(() => onMobileStreamFailure(() => { chatLoadGeneration.current += 1; profileLoadGeneration.current += 1; cancelActiveObservation(); setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…')); }), [cancelActiveObservation]);
  useEffect(() => {
    const resume = () => { if (!document.hidden) setChatResumeEpoch(value => value + 1); };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, []);

  // Load per-Bot Scheduled Tasks
  const loadBotSchedules = useCallback(
    async (bot: UnifiedBotItem) => {
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
        setBotScheduleState(nextState);
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
      cancelActiveObservation();
      // 等这次加载结束再安排重试，避免多片传输被 2 秒定时器反复作废。
      setChatHistoryError('');
      setChatObservationError('');
      const generation = ++chatLoadGeneration.current;
      const current = () => generation === chatLoadGeneration.current;
      // 同一聊天前台恢复/重连时保留现有 live，直到新快照到达；旧消息只来自实时快照时不会被清空。
      const historyErrorText = t('历史记录暂时无法加载，正在重试…', 'History temporarily unavailable; retrying…');

      if (bot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') return;
        try {
          const items = await fetchBotHistoryPages(async (cursor, limit, chunked) => {
            if (!current()) return null;
            const histEnv = await BotHost.call({
              method: 'history',
              params: { botId: bot.botId, limit, ...(chunked ? { chunked: true } : {}), ...(cursor ? { cursor } : {}) },
            });
            return (histEnv.result as HostHistoryPage) ?? null;
          });
          if (!current()) return;
          setChatHistory(previous => mergeHistory(previous, items));
          const turns = parseHistoryEntries(items, clearedMap[bot.key] ?? 0);
          const lastTurn = turns.at(-1);
          if (lastTurn?.text) {
            updateBotMeta(bot.key, { lastText: lastTurn.text, unread: false });
          }
          setChatHistoryError('');
        } catch {
          if (current()) setChatHistoryError(historyErrorText);
        }
        if (!current()) return;
        try {
          const obsId = uuid();
          observeIdRef.current = obsId;
          await BotHost.observe({ observationId: obsId, target: { kind: 'primary', botId: bot.botId } });
          if (current()) setChatObservationError('');
          if (!current()) void BotHost.cancelObservation({ observationId: obsId }).catch(() => {});
        } catch {
          if (current()) { observeIdRef.current = undefined; setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…')); }
        }
      } else if (bot.hostKind === 'remote' && bot.remoteIdentity && remoteClientRef.current) {
        const api = remoteClientRef.current.api;
        if (!api.transportConnected) return;
        const identity = bot.remoteIdentity;
        try {
          const items = await fetchBotHistoryPages(async (cursor, limit, chunked) => {
            if (!current()) return null;
            const page = await api.call(identity, 'history', {
              botId: bot.botId,
              limit,
              ...(chunked ? { chunked: true } : {}),
              ...(cursor ? { cursor } : {}),
            });
            return (page as unknown as HostHistoryPage) ?? null;
          });
          if (!current()) return;
          setChatHistory(previous => mergeHistory(previous, items));
          const turns = parseHistoryEntries(items, clearedMap[bot.key] ?? 0);
          const lastTurn = turns.at(-1);
          if (lastTurn?.text) {
            updateBotMeta(bot.key, { lastText: lastTurn.text, unread: false });
          }
          setChatHistoryError('');
        } catch {
          if (current()) setChatHistoryError(historyErrorText);
        }
        if (!current()) return;
        try {
          const handle = api.observe(identity, { kind: 'primary', botId: bot.botId }, ev => {
            if (!current()) return;
            if ('error' in ev) { setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…')); return; }
            const frame = ev.frame;
            if (frame.type === 'snapshot') {
              setChatLive(frame.state);
            } else if (frame.type === 'update') {
              setChatLive(prev => (prev ? { ...prev, ...frame.changes } : prev));
            } else if (frame.type === 'end') {
              setChatLive(undefined);
            }
          });
          remoteObserveRef.current = handle;
          void handle.ready.then(() => { if (current()) setChatObservationError(''); }, () => { if (current()) setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…')); });
        } catch {
          remoteObserveRef.current = null;
          if (current()) setChatObservationError(t('连接中断，正在恢复…', 'Connection interrupted; recovering…'));
        }
      }
    },
    [cancelActiveObservation, clearedMap, ensureLocalHostRunning, updateBotMeta, t],
  );

  useEffect(() => {
    if (screen !== 'chat' || !active || !activeBot || document.hidden) return;
    if (activeBot.hostKind === 'remote' && (!remoteConnected || activeBot.online === false)) return;
    void loadBotHistoryAndObserve(activeBot);
    return () => { chatLoadGeneration.current += 1; cancelActiveObservation(); };
    // Rebuild for a new target, transport generation, or foreground transition, not display metadata.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, active, activeBot?.key, activeBot?.remoteIdentity?.generation, activeBot?.online, remoteConnected, chatResumeEpoch, connectionEpoch]);

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
    const readHistory = async (): Promise<Array<Record<string, unknown>> | null> => {
      if (chatHostKind === 'local') {
        return fetchBotHistoryPages(async (cursor, limit, chunked) => {
          if (!alive) return null;
          const env = await BotHost.call({
            method: 'history',
            params: { botId: chatBotId, limit, ...(chunked ? { chunked: true } : {}), ...(cursor ? { cursor } : {}) },
          });
          return (env.result as HostHistoryPage) ?? null;
        });
      }
      if (!remoteTarget) return null;
      return fetchBotHistoryPages(async (cursor, limit, chunked) => {
        if (!alive) return null;
        const page = await remoteTarget.api.call(remoteTarget.identity, 'history', {
          botId: chatBotId,
          limit,
          ...(chunked ? { chunked: true } : {}),
          ...(cursor ? { cursor } : {}),
        });
        return (page as unknown as HostHistoryPage) ?? null;
      });
    };

    let alive = true;
    // 语音提交也可能直接返回终态，没有 queued/placed 可供轮询。
    if (chatReceiptStatus === 'done' || chatReceiptStatus === 'unanswered') {
      void readHistory().then(items => {
        if (alive && chatSubmissionRef.current === submission && items) setChatHistory(previous => mergeHistory(previous, items));
      }).catch(() => {});
      return () => {
        alive = false;
      };
    }
    let polling = false;
    const timer = window.setInterval(async () => {
      if (!alive || polling || document.hidden || (chatHostKind === 'local' && localInFlight.current.has(requestId))) return;
      polling = true;
      try {
        const next = await readSubmission();
        if (!alive || chatSubmissionRef.current !== submission || !next || next.requestId !== requestId) return;
        const entry = chatPending && pendingByBot.current.get(chatPending.scopeKey);
        const nextAdmission = (next as TurnAdmissionCarrier).admission ?? null;
        if (next.status !== 'done' && next.status !== 'unanswered') {
          if (entry?.pending.requestId === requestId) updatePending({ pending: { ...entry.pending, phase: 'accepted', admission: nextAdmission }, receipt: next });
          else setChatReceipt(next);
          return;
        }
        // 终态：先回读历史再提交 receipt，避免 receipt 重渲染 cleanup 把 alive 置 false 丢掉后续写入。
        const items = await readHistory().catch(() => null);
        if (!alive || chatSubmissionRef.current !== submission) return;
        // 回读失败也要落终态 receipt，不能停在生成中；随后同步提交，无新的异步窗口。
        if (entry?.pending.requestId === requestId) updatePending({ pending: { ...entry.pending, phase: 'accepted', admission: nextAdmission }, receipt: next });
        else setChatReceipt(next);
        if (items) setChatHistory(previous => mergeHistory(previous, items));
        // 摘要只取真实答案；无答案（unanswered）保留 submit 时写入的用户消息摘要，不被历史旧文本覆盖。
        if (next.answerText) {
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
    chatRequestId, chatReceiptStatus, chatResumeEpoch, chatPending?.scopeKey, updateBotMeta, syncLocalBots, syncRemoteBots,
  ]);

  const openBotChat = (bot: UnifiedBotItem, fromScreen?: 'hub' | 'archived-bots') => {
    profileLoadGeneration.current += 1;
    scheduleLoadGeneration.current += 1;
    const scopeKey = scopeForBot(bot);
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
      // 切目标立即 fence 旧加载/观察，防旧 callback 回填新聊天。
      chatLoadGeneration.current += 1;
      cancelActiveObservation();
      setChatHistory([]);
      setChatLive(undefined);
      setChatObservationError('');
      setChatHistoryError('');
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
    setChatReturnScreen(fromScreen ?? (screen === 'archived-bots' || bot.archivedAt ? 'archived-bots' : 'hub'));
    setScreen('chat');
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

  const openBotProfile = (bot: UnifiedBotItem, fromScreen?: HubScreen) => {
    setHubContextMenu(null);
    setChatTopMenuOpen(false);
    setComposerMenuOpen(false);
    setActiveBotKey(bot.key);
    setProfileReturnScreen(fromScreen ?? (screen === 'hub' || screen === 'archived-bots' || screen === 'chat' ? screen : 'chat'));
    setScreen('bot-profile');
    void loadBotSoul(bot);
    void loadBotSchedules(bot);
  };

  const openBotSchedules = (bot: UnifiedBotItem) => {
    setChatTopMenuOpen(false);
    setComposerMenuOpen(false);
    setActiveBotKey(bot.key);
    setScheduleEditing(null);
    setScheduleFilter('all');
    setScreen('bot-schedules');
    void loadBotSchedules(bot);
  };

  // 经中心权威通道重新读取 cwd 与 CAS revision；整条链路异常都不得逃逸，
  // 迟到的结果只由 fetchRef 身份令牌拦截，不写新表单。
  const loadEditCwd = useCallback(async (bot: UnifiedBotItem) => {
    const fetchId = ++editCwdFetchRef.current;
    try {
      const api = await ensureRemoteApi();
      const identity = api?.identity;
      if (!api || !identity) throw new Error(t('中心连接不可用，无法读取工作目录；连接后可重试', 'Center unavailable; cannot load the working directory. Retry once connected'));
      const config = await api.broker(identity, 'center_bot_cwd_get', { deviceId: bot.deviceId, botId: bot.botId });
      if (editCwdFetchRef.current !== fetchId) return false;
      if (!editCwdDirtyRef.current) setEditCwd(config.value ?? bot.cwd ?? '');
      setEditCwdRevision(config.revision);
      setEditCwdError('');
      return true;
    } catch (error) {
      if (editCwdFetchRef.current !== fetchId) return false;
      setEditCwdRevision(null);
      setEditCwdError(t('工作目录读取失败：', 'Failed to load the working directory: ') + errorText(error));
      return false;
    }
  }, [ensureRemoteApi, t]);

  const openBotEdit = (bot: UnifiedBotItem) => {
    const meta = botMetaMap[bot.key];
    const preset = resolveBotAvatarPreset(botAvatarKey(bot), bot.role, bot.isPrimary);
    editCwdFetchRef.current++;
    setEditMode('edit');
    setEditMakePrimary(Boolean(bot.isPrimary));
    setEditName(bot.role);
    setEditSubtitle(bot.description ?? '');
    editCwdDirtyRef.current = false;
    setEditCwd(bot.cwd || localHost?.workspace || '');
    setEditCwdRevision(null);
    setEditCwdError('');
    setEditAvatarPreset(preset);
    setEditVoiceTone(meta?.voiceTone ?? '未设置');
    setEditVoiceSpeed(meta?.voiceSpeed ?? '1x');
    setEditVoiceLang(meta?.voiceLang ?? '自动');
    setScreen('bot-edit');
    void loadBotSoul(bot);
  };

  // 编辑期间以完整身份（设备+bot+连接 profile/generation）为键重读修订；
  // 离开表单/切 create/换目标即失效旧请求，迟到结果不写新表单。
  const editCwdIdentity = activeBot
    ? activeBot.deviceId + ':' + activeBot.botId + ':' +
      (activeBot.remoteIdentity
        ? activeBot.remoteIdentity.profileId + '/' + activeBot.remoteIdentity.generation
        : 'local')
    : '';
  useEffect(() => {
    if (screen !== 'bot-edit' || editMode !== 'edit' || !activeBot) return;
    void loadEditCwd(activeBot);
    return () => {
      // 身份/表单变化：旧修订立即作废，绝不允许旧 CAS 凭据写新目标。
      editCwdFetchRef.current++;
      setEditCwdRevision(null);
    };
  }, [screen, editMode, editCwdIdentity, remoteConnected, loadEditCwd]);

  const openCreateBotPage = useCallback((forcePrimary = false) => {
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
    setEditAvatarPreset(nextPreset);
    setEditInitialSoul('');
    setSoulDraft('');
    setSoulDirty(false);
    setEditVoiceTone('未设置');
    setEditVoiceSpeed('1x');
    setEditVoiceLang('自动');
    setScreen('bot-edit');
  }, [listBotItems.length]);

  useEffect(() => {
    if (mustCreatePrimaryBot && screen === 'hub') {
      openCreateBotPage(true);
    }
  }, [mustCreatePrimaryBot, screen, openCreateBotPage]);

  const openAvatarPicker = (fromScreen: HubScreen, currentPreset: GrokAvatarPreset) => {
    setAvatarReturnScreen(fromScreen);
    setDraftAvatar({ ...currentPreset });
    setAvatarTab('shape');
    setScreen('bot-avatar');
  };

  const [slashBusy, setSlashBusy] = useState<SlashCommandName>();
  const slashBusyRef = useRef(false);
  /** 停止失败单独提示，与 action.error（发送等）分开保留；成功由 Host activity stopped 呈现。 */
  const [stopError, setStopError] = useState('');

  // /clear 与 /compact 都先等后端成功，再用服务端边界重置本地可见历史；失败保留草稿与原历史。
  // 返回 true 表示服务端已成功（即使 UI 已切到别的会话），false 表示 UI 切走后不再报错的过期结果。
  const runSlashCommand = useCallback(async (command: SlashCommandName): Promise<boolean> => {
    const bot = activeBot;
    if (!bot) throw new Error(t('请先选择一个智能体。', 'Select a bot first.'));
    if (slashBusyRef.current) throw new Error(t('上一个命令仍在执行，请稍候。', 'The previous command is still running.'));
    if (chatPending?.botKey === bot.key && chatPending.phase !== 'accepted') {
      throw new Error(t('原请求尚未确认，不能清空或压缩。', 'The original request is unconfirmed; clear or compact is blocked.'));
    }
    if (bot.archivedAt) throw new Error(t('该智能体已归档，请先恢复后再操作。', 'This bot is archived. Unarchive it first.'));
    const scopeKey = scopeForBot(bot);
    if (!scopeKey) throw new Error(t('目标身份尚未就绪，草稿已保留。', 'Target identity unavailable; draft retained.'));
    const draftSnapshot = readChatDraft(scopeKey);
    slashBusyRef.current = true;
    setSlashBusy(command);
    setClearNotice(command === '/clear'
      ? t('正在清空对话…', 'Clearing conversation…')
      : t('正在压缩上下文…', 'Compacting context…'));
    try {
      let cleared: ClearHistoryResult | undefined;
      let compacted: CompactResult | undefined;
      if (bot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') throw new Error(t('本机服务未运行，草稿已保留。', 'Local host is not running; draft retained.'));
        const env = await BotHost.call({ method: command === '/clear' ? 'clearHistory' : 'compact', params: { botId: bot.botId } });
        if (command === '/clear') cleared = env.result as ClearHistoryResult;
        else compacted = env.result as CompactResult;
      } else {
        if (!bot.remoteIdentity || !remoteClientRef.current || !remoteConnected) {
          throw new Error(t('目标离线，草稿已保留。', 'Target offline; draft retained.'));
        }
        const result = await remoteClientRef.current.api.call(
          bot.remoteIdentity,
          command === '/clear' ? 'clearHistory' : 'compact',
          { botId: bot.botId },
        );
        if (command === '/clear') cleared = result as unknown as ClearHistoryResult;
        else compacted = result as unknown as CompactResult;
      }
      // 切换 Bot 后只影响服务端，不清新 Bot 的草稿/UI。
      if (currentChatScope.current !== scopeKey) return true;
      setComposerMenuOpen(false);
      setChatTopMenuOpen(false);
      if (command === '/clear') {
        // 以服务端 reset 条目为唯一水位；未建会话时 0 也是真实水位，不额外抬高。
        const nextCutoff = Math.max(cleared?.clearedThroughEntryId ?? 0, clearedMap[bot.key] ?? 0);
        setClearedMap(prev => {
          const updated = { ...prev, [bot.key]: nextCutoff };
          writeClearedMap(updated);
          return updated;
        });
        chatSubmissionRef.current = undefined;
        if (chatPending) removePending(chatPending.scopeKey, chatPending.requestId);
        setChatPending(undefined);
        setChatHistory([]);
        setChatLive(undefined);
        setChatObservationError('');
        setChatHistoryError('');
        setChatReceipt(undefined);
        setChatDraft('');
        setChatDraftAttachments([]);
        writeChatDraft(scopeKey, '');
        writeChatDraftAttachments(scopeKey, []);
        updateBotMeta(bot.key, { lastText: t('对话已清空', 'History cleared'), updatedAt: Date.now(), unread: false });
        setClearNotice(t('已清空当前对话并重置上下文', 'Conversation cleared and context reset'));
      } else {
        // /compact 成功后才清掉实际命令草稿；若等待期间已写入新文本则保留，不误删。
        if (draftSnapshot.trim() === command) {
          if (readChatDraft(scopeKey) === draftSnapshot) writeChatDraft(scopeKey, '');
          setChatDraft(previous => previous.trim() === command ? '' : previous);
        }
        setClearNotice(compacted?.compacted
          ? t('已压缩较早的上下文', 'Earlier context compacted')
          : t('没有可压缩的历史', 'Nothing to compact'));
      }
      window.setTimeout(() => setClearNotice(''), 2500);
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
  }, [activeBot, chatPending, clearedMap, ensureLocalHostRunning, remoteConnected, removePending, t, updateBotMeta]);

  const sendMessage = () =>
    action.run(async () => {
      const bot = activeBot;
      if (!bot) return;
      if (bot.hostKind === 'remote') {
        setOfflineNotice({ botKey: bot.key, text: t('目标离线，草稿已保留。', 'Target offline; draft retained.') });
        return;
      }
      if (chatPending?.botKey === bot.key && chatPending.phase !== 'accepted') throw new Error(t('原请求尚未确认，请勿重复发送。', 'Original request is unconfirmed; do not resend.'));
      if (bot.archivedAt) throw new Error(t('该智能体已归档，请先恢复后再发送消息', 'This bot is archived. Unarchive it first.'));
      if (imageUploading) return;
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
      const attachmentIds = draftAttachmentMetas.map((a) => a.id);
      const submission = {
        botKey: bot.key, scopeKey, requestId: uuid(), text: trimmed,
        ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
        phase: 'sending' as const,
        submittedAt: Date.now(),
        afterEntryId: Math.max(maxHistoryEntryId(chatHistory), Number(chatLive?.lastEntryId) || 0, clearedMap[bot.key] ?? 0),
      };
      chatSubmissionRef.current = submission;
      updatePending({ pending: submission }, false);
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
        const savedText = writeChatDraft(scopeKey, restored);
        const savedAtt = writeChatDraftAttachments(scopeKey, draftAttachmentMetas);
        if (savedText && savedAtt) removePending(scopeKey, submission.requestId);
        else updatePending({ pending: { ...submission, phase: 'recovering' } }, false);
        if (currentChatScope.current === scopeKey) {
          setChatDraft(restored);
          setChatDraftAttachments(draftAttachmentMetas);
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
          const result = await BotHost.call({ method: 'submit', params: { botId: bot.botId, requestId: submission.requestId, text: trimmed, ...(attachmentIds.length ? { attachments: attachmentIds } : {}) } });
          receipt = result.result as HostSubmission;
        } catch (error) {
          if (stillOwned()) {
            if ((error as { outcome?: string })?.outcome === 'not-sent') restore();
            else updatePending({ pending: { ...submission, phase: 'recovering' } });
          }
          if (currentChatScope.current === scopeKey) throw error;
          return;
        }
        if (!stillOwned()) return;
        updatePending({ pending: { ...submission, phase: 'accepted', admission: (receipt as TurnAdmissionCarrier).admission ?? null }, receipt });
        const items = await fetchBotHistoryPages(async (cursor, limit, chunked) => {
          if (currentChatScope.current !== scopeKey || !stillOwned()) return null;
          const env = await BotHost.call({
            method: 'history',
            params: { botId: bot.botId, limit, ...(chunked ? { chunked: true } : {}), ...(cursor ? { cursor } : {}) },
          });
          return (env.result as HostHistoryPage) ?? null;
        }).catch(() => null);
        if (currentChatScope.current === scopeKey && stillOwned() && items && items.length > 0) {
          setChatHistory(previous => mergeHistory(previous, items));
        }
      } finally {
        localInFlight.current.delete(submission.requestId);
      }
    });

  // 受理失败的 Host 队列请求按同一 requestId/原文显式重试；submit 端按请求标识幂等，不新建消息。
  const retryAdmission = () =>
    action.run(async () => {
      const bot = activeBot;
      const entry = activeChatScope ? pendingByBot.current.get(activeChatScope) : undefined;
      if (!bot || bot.hostKind !== 'local' || !entry?.pending.requestId || entry.pending.botKey !== bot.key) return;
      const { requestId, text, scopeKey } = entry.pending;
      const stillOwned = () => pendingByBot.current.get(scopeKey)?.pending.requestId === requestId;
      if (!stillOwned()) return;
      if (!centerConn.ready || centerConn.status?.state === 'disconnected') {
        setOfflineNotice({ botKey: bot.key, text: t('中心离线，草稿已保留。', 'Center offline; draft retained.') });
        return;
      }
      const snap = await ensureLocalHostRunning();
      if (!snap || snap.phase !== 'running' || !stillOwned()) return;
      try {
        const result = await BotHost.call({ method: 'submit', params: { botId: bot.botId, requestId, text } });
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
      const { requestId, text, scopeKey } = entry.pending;
      const stillOwned = () => pendingByBot.current.get(scopeKey)?.pending.requestId === requestId;
      if (!stillOwned()) return;
      if (!remoteConnected || bot.online === false) {
        setOfflineNotice({ botKey: bot.key, text: t('目标离线，草稿已保留。', 'Target offline; draft retained.') });
        return;
      }
      try {
        const result = await remoteClientRef.current.api.call(bot.remoteIdentity, 'submit', { botId: bot.botId, requestId, text, ...(entry.pending.attachments?.length ? { attachments: entry.pending.attachments } : {}) });
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
  const handleSaveBotEdit = () =>
    action.run(async () => {
      const roleName = editName.trim();
      if (!roleName) return;

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
            lastText: editSubtitle.trim() || t('点击开始文字对话…', 'Tap to start chatting…'),
            updatedAt: Date.now(),
            unread: true,
            voiceTone: editVoiceTone,
            voiceSpeed: editVoiceSpeed,
            voiceLang: editVoiceLang,
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
          await syncLocalBots(snap);
          openBotChat({
            key,
            deviceId: created.deviceId,
            botId: created.botId,
            role: roleName,
            cwd: created.cwd,
            modelRef: created.modelRef,
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
            lastText: editSubtitle.trim() || t('点击开始文字对话…', 'Tap to start chatting…'),
            updatedAt: Date.now(),
            unread: true,
            voiceTone: editVoiceTone,
            voiceSpeed: editVoiceSpeed,
            voiceLang: editVoiceLang,
          });
          await syncRemoteBots();
          setScreen('hub');
        }
      } else if (activeBot) {
        // Editing an existing Bot updates the authoritative shared profile.
        const trimmedCwd = editCwd.trim();
        const cwdChanged = trimmedCwd !== (activeBot.cwd ?? '');
        const profileChanged = roleName !== activeBot.role || editSubtitle.trim() !== (activeBot.description ?? '');
        if (!trimmedCwd) throw new Error(t('工作目录不能为空', 'Working directory cannot be empty'));
        const saveCwd = async () => {
          if (!cwdChanged) return;
          if (editCwdRevision === null) {
            throw new Error(t('工作目录修订尚未读取，请重新读取后再保存', 'Working directory revision not loaded; reload before saving'));
          }
          const api = await ensureRemoteApi();
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
            setEditCwdRevision(config.revision);
            editCwdDirtyRef.current = false;
            setEditCwd(config.value ?? trimmedCwd);
          } catch (error) {
            const code = (error as { code?: string })?.code;
            if (code === 'REVISION_CONFLICT' || code === 'REQUEST_CONFLICT') {
              setEditCwdRevision(null);
              setEditCwdError(t('工作目录已被其他修改占用，请重新读取后再保存', 'Working directory was changed elsewhere; reload and save again'));
            }
            throw error;
          }
        };
        if (activeBot.hostKind === 'local') {
          if (profileChanged) await BotHost.call({ method: 'updateBotProfile', params: { botId: activeBot.botId, name: roleName, description: editSubtitle.trim() } });
          // 本机 Bot 的 cwd 由中心权威管理：只经中心 CAS 通道写入，
          // 没有中心连接时不静默绕开写 Host 本地。
          await saveCwd();
          await syncLocalBots();
        } else if (activeBot.remoteIdentity && remoteClientRef.current) {
          if (profileChanged) await remoteClientRef.current.api.call(activeBot.remoteIdentity, 'updateBotProfile', { botId: activeBot.botId, name: roleName, description: editSubtitle.trim() });
          await saveCwd();
          await syncRemoteBots();
        } else throw new Error('Remote target unavailable');
        await saveAvatar(activeBot, editAvatarPreset);
        updateBotMeta(activeBot.key, {
          customName: roleName,
          subtitle: editSubtitle.trim(),
          voiceTone: editVoiceTone,
          voiceSpeed: editVoiceSpeed,
          voiceLang: editVoiceLang,
        });
        setScreen('bot-profile');
      }
    });

  const handleSetPrimaryBot = (bot: UnifiedBotItem) =>
    action.run(async () => {
      setChatTopMenuOpen(false);
      if (bot.archivedAt) {
        throw new Error(t('已归档的智能体不能直接设为主智能体，请先恢复', 'Archived bot cannot be set as primary. Unarchive it first.'));
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
      action.setError(t('主智能体受保护，请先将其他智能体设为主智能体后再归档', 'Primary bot is protected. Switch primary bot before archiving.'));
      return;
    }
    setBotConfirmModal({ kind: 'archive', bot });
  };

  const handleArchiveBot = (bot: UnifiedBotItem) =>
    action.run(async () => {
      setChatTopMenuOpen(false);
      if (bot.isPrimary) {
        throw new Error(t('主智能体受保护，请先将其他智能体设为主智能体后再归档', 'Primary bot is protected. Switch primary bot before archiving.'));
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
      if (screen !== 'hub') setScreen('hub');
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
      action.setError(t('主智能体受保护，不能直接删除。请先将其他智能体设为主智能体。', 'Primary bot is protected. Switch primary bot before deleting.'));
      return;
    }
    setBotConfirmModal({ kind: 'delete', bot });
  };

  const handleDeleteBot = (bot: UnifiedBotItem) =>
    action.run(async () => {
      setChatTopMenuOpen(false);
      if (bot.isPrimary) {
        throw new Error(t('主智能体受保护，不能直接删除。请先将其他智能体设为主智能体。', 'Primary bot is protected. Switch primary bot before deleting.'));
      }
      if (bot.hostKind === 'local') {
        const snap = await ensureLocalHostRunning();
        if (!snap || snap.phase !== 'running') throw new Error(t('本机服务未运行', 'Local host not running'));
        await BotHost.call({ method: 'deleteBot', params: { botId: bot.botId } });
        await syncLocalBots(snap);
      } else if (bot.remoteIdentity && remoteClientRef.current) {
        if (!remoteConnected || bot.online === false) {
          throw new Error(t('目标设备离线，已拒绝修改', 'Target device is offline; operation rejected'));
        }
        await remoteClientRef.current.api.call(bot.remoteIdentity, 'deleteBot', { botId: bot.botId });
        await syncRemoteBots();
      } else {
        throw new Error(t('无法连接目标节点', 'Target host unavailable'));
      }
      chatPins.removePin(botPinKey(bot));
      setBotConfirmModal(null);
      if (activeBotKey === bot.key) {
        cancelActiveObservation();
        setActiveBotKey(null);
      }
      const returnToArchived =
        screen === 'archived-bots' ||
        ((screen === 'chat' || screen === 'bot-profile') && chatReturnScreen === 'archived-bots');
      setScreen(returnToArchived ? 'archived-bots' : 'hub');
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
    [resolveRoomApi, chatPins, roomPinKey, knownBots, t],
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
          error: t(
            '上次解散请求结果未确认，已保留原请求 ID，不会自动以新 ID 重发；请按原 ID 确认。',
            'Previous disband request is unconfirmed. Original request ID is retained; confirm by original ID.',
          ),
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
            if (scopeConversationTarget?.scope.scope.scopeId === attempt.scopeId) {
              setRoomSettingsOpen(false);
              setScopeConversationTarget(null);
              setScreen('hub');
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
            if (scopeConversationTarget?.scope.scope.scopeId === attempt.scopeId) {
              setRoomSettingsOpen(false);
              setScopeConversationTarget(null);
              setScreen('hub');
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
      if (scopeConversationTarget?.scope.scope.scopeId === attempt.scopeId) {
        setRoomSettingsOpen(false);
        setScopeConversationTarget(null);
        setScreen('hub');
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
              error: t(
                `解散结果未确认（${errorText(err)}）。已冻结原请求 ID，可按原 ID 确认，不会使用新 ID 自动重发。`,
                `Disband unconfirmed (${errorText(err)}). Original request ID frozen; confirm by original ID without auto-resending.`,
              ),
            }
          : null,
      );
    }
  }, [roomDeleteModal, resolveRoomApi, chatPins, roomPinKey, scopeConversationTarget, t]);

  const openModelPickerSheet = (_target: 'bot-edit' | 'bot-profile', tab: BotSettingsTab = 'model') => {
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
        setScreen(subPageReturnScreen);
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
      setScreen(subPageReturnScreen);
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
      title: task.title,
      prompt: task.prompt ?? '',
      repeat: task.repeat,
      time: task.time || '08:00',
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
      }

      if (scheduleEditing === 'edit' && scheduleDraft.id && scheduleDraft.revision) {
        await executeActiveBotSchedule({
          action: 'update',
          id: scheduleDraft.id,
          revision: scheduleDraft.revision,
          ...basePayload,
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

  const submission = chatSubmissionRef.current;
  // 用户主动停止的 unanswered 回执（reason aborted/cancelled）是已停止结算，不是配置/模型故障：
  // 既不弹“未获得回答/检查配置”卡，也不让 WorkingSlot 按 error 结算；真实 model_error 等仍显示。
  const receiptUserCancelled =
    chatReceipt?.status === 'unanswered' &&
    typeof chatReceipt.reason === 'string' &&
    /abort|cancel/i.test(chatReceipt.reason);
  const submissionFailure = submission && chatReceipt?.status === 'unanswered' && !receiptUserCancelled &&
    submission.botKey === activeBot?.key && chatReceipt.requestId === submission.requestId &&
    !parseHistoryEntries(chatHistory).some(turn => turn.error && turn.entryId > submission.afterEntryId)
      ? chatReceipt.reason === 'model_error'
        ? t('模型生成失败，请重试或检查模型配置。', 'Model generation failed. Retry or check the model configuration.')
        : t('本次请求未获得回答，请重试。', 'No answer was generated for this request. Please retry.')
      : undefined;

  const recoveringChat = chatPending?.botKey === activeBot?.key && chatPending?.phase === 'recovering';
  const liveGenerationAttr = chatLive?.generation?.attribution;
  const liveGeneratingText = recoveringChat ? '' : chatLive?.generation?.text ?? '';

  // 当前会话的按轮受理状态：优先 live turnAdmission，其次提交回执/持久化 pending 上的 admission。
  const liveTurnAdmission = chatLive?.turnAdmission ?? null;
  const pendingAdmission = chatPending?.botKey === activeBot?.key
    ? (chatPending?.admission ?? (chatReceipt as TurnAdmissionCarrier | undefined)?.admission ?? null)
    : null;
  const chatTurnAdmission =
    liveTurnAdmission && (!chatPending?.requestId || liveTurnAdmission.requestId === chatPending.requestId)
      ? liveTurnAdmission
      : pendingAdmission;
  const admissionStatusText = !chatTurnAdmission
    ? ''
    : chatTurnAdmission.phase === 'failed'
      ? t(
          '同步失败：' + (chatTurnAdmission.error?.message || chatTurnAdmission.error?.code || '') + '，消息已保留。',
          'Sync failed: ' + (chatTurnAdmission.error?.message || chatTurnAdmission.error?.code || '') + '; message retained.',
        )
      : chatTurnAdmission.phase === 'checking'
        ? t('正在检查插件版本…', 'Checking plugin versions…')
        : chatTurnAdmission.phase === 'synchronizing'
          ? t('正在同步插件…', 'Synchronizing plugins…')
          : t('排队等待受理…', 'Queued for admission…');

  // 统一活动状态：新 Host 帧带 activity 则以它为准；旧 Host 缺省走 resolveBotActivity 的旧字段 fallback。
  // 只有尚未受理的发送中阶段才允许乐观叠加 queued；一旦 Host 有真实 activity（含 failed/stopped），
  // 完全以 Host 为准，旧 queued/placed 回执仅在旧 Host fallback 内体现，不回写覆盖终态。恢复/离线不伪装工作。
  const rawBotActivity = resolveBotActivity(
    recoveringChat || (chatHostKind === 'remote' && !(chatRemoteConnected && activeBot?.online !== false))
      ? null
      : chatLive,
  );
  /** 停止在途按 bot.key 去重：切换 Bot 不复用其他 Bot 的 abort Promise。 */
  const stopInFlightRef = useRef(new Map<string, Promise<unknown>>());
  const [stopping, setStopping] = useState<Set<string>>(() => new Set());
  const isStoppingBot = Boolean(activeBot && stopping.has(activeBot.key));

  const sendingOptimistic = !recoveringChat && chatPending?.botKey === activeBot?.key && chatPending?.phase === 'sending';
  // 本地停止在途时无条件显示 stopping（覆盖 Host 尚未更新的 running）；
  // 仅未受理的发送中阶段才在 Host 空闲/failed/stopped 上叠加乐观 queued，受理后完全以 Host activity 为准。
  const botActivity: BotActivity = isStoppingBot
    ? { ...rawBotActivity, phase: 'stopping' }
    : sendingOptimistic && !isBotActivityBusy(rawBotActivity)
      ? { ...rawBotActivity, phase: 'queued', source: 'primary' }
      : rawBotActivity;
  const isBotBusy = isBotActivityBusy(botActivity) || Boolean(sendingOptimistic);
  // Host activity.error（phase 'failed' 附带的有界诊断）是最具体的失败原因：
  // 直接展示 message/code 原文，不加「Host」字样或身份前缀；无此字段回落原回执提示。
  const activityFailure =
    botActivity.phase === 'failed' && botActivity.error
      ? botActivity.error.message || botActivity.error.code
      : undefined;
  const failureNotice = activityFailure || submissionFailure;
  const canStopBot = Boolean(
    activeBot && !activeBot.archivedAt && canStopBotActivity(botActivity) &&
    (activeBot.hostKind !== 'remote' || (remoteConnected && activeBot.online !== false)),
  );
  const requestStopBot = useCallback((bot: UnifiedBotItem): Promise<unknown> => {
    const inflight = stopInFlightRef.current.get(bot.key);
    if (inflight) return inflight;
    const task = (async () => {
      if (bot.hostKind === 'local') {
        await BotHost.call({ method: 'abort', params: { botId: bot.botId } });
      } else {
        if (!bot.remoteIdentity || !remoteClientRef.current) {
          throw new Error(t('目标离线，未停止。', 'Target offline; not stopped.'));
        }
        await remoteClientRef.current.api.call(bot.remoteIdentity, 'abort', { botId: bot.botId });
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

  /** 问卷提交走现有 callCapabilityAction；deviceId/botId 由宿主授权，不自建协议。 */
  const submitQuestionnaire = useCallback(
    async (presentation: { installationId: string }, input: QuestionnaireSubmitPayload) => {
      if (!activeBot) throw new Error(t('目标不可用，未提交', 'Target unavailable; not submitted'));
      if (activeBot.hostKind === 'local') {
        const deviceId = localHost?.deviceId;
        if (!deviceId) throw new Error(t('本机设备身份未就绪，未提交', 'Local device identity not ready; not submitted'));
        const env = await BotHost.call({
          method: 'callCapabilityAction',
          params: {
            installationId: presentation.installationId,
            action: 'answerQuestionnaire',
            request: { requestId: uuid(), deviceId, botId: activeBot.botId, input },
          },
        });
        return env?.result;
      }
      const api = remoteClientRef.current?.api;
      const identity = activeBot.remoteIdentity;
      if (!api || !identity || !remoteConnected || activeBot.online === false) {
        throw new Error(t('目标设备离线，未提交', 'Target device offline; not submitted'));
      }
      const res = await api.call(identity, 'callCapabilityAction', {
        installationId: presentation.installationId,
        action: 'answerQuestionnaire',
        request: { requestId: uuid(), deviceId: identity.targetDeviceId, botId: activeBot.botId, input },
      });
      return (res as { result?: unknown })?.result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeBot?.key, localHost?.deviceId, remoteConnected, t],
  );

  const activeLiveToolName = useMemo(() => {
    const tools = array<Record<string, unknown>>(chatLive?.tools);
    for (let i = tools.length - 1; i >= 0; i--) {
      const slot = tools[i];
      const name = typeof slot?.name === 'string' ? slot.name.trim() : '';
      const status = typeof slot?.status === 'string' ? slot.status : '';
      if (name && (status === 'running' || status === 'pending' || status === 'started' || !status)) {
        return name;
      }
    }
    const last = tools[tools.length - 1];
    return typeof last?.name === 'string' && chatLive?.busy && !liveGeneratingText
      ? last.name.trim()
      : null;
  }, [chatLive?.tools, chatLive?.busy, liveGeneratingText]);

  const prevChatBusyRef = useRef(false);
  useEffect(() => {
    const wasBusy = prevChatBusyRef.current;
    prevChatBusyRef.current = isBotBusy;
    if (!wasBusy || isBotBusy || screen !== 'chat' || !active || !activeBot || document.hidden) return;
    const targetBot = activeBot;
    const scopeKey = currentChatScope.current;
    void (async () => {
      try {
        if (targetBot.hostKind === 'local') {
          const items = await fetchBotHistoryPages(async (cursor, limit, chunked) => {
            if (currentChatScope.current !== scopeKey) return null;
            const env = await BotHost.call({
              method: 'history',
              params: { botId: targetBot.botId, limit, ...(chunked ? { chunked: true } : {}), ...(cursor ? { cursor } : {}) },
            });
            return (env.result as HostHistoryPage) ?? null;
          });
          if (currentChatScope.current === scopeKey && items.length > 0) {
            setChatHistory(previous => mergeHistory(previous, items));
          }
        } else if (targetBot.hostKind === 'remote' && targetBot.remoteIdentity && remoteClientRef.current?.api.transportConnected) {
          const api = remoteClientRef.current.api;
          const identity = targetBot.remoteIdentity;
          const items = await fetchBotHistoryPages(async (cursor, limit, chunked) => {
            if (currentChatScope.current !== scopeKey) return null;
            const page = await api.call(identity, 'history', {
              botId: targetBot.botId,
              limit,
              ...(chunked ? { chunked: true } : {}),
              ...(cursor ? { cursor } : {}),
            });
            return (page as unknown as HostHistoryPage) ?? null;
          });
          if (currentChatScope.current === scopeKey && items.length > 0) {
            setChatHistory(previous => mergeHistory(previous, items));
          }
        }
      } catch {
        // Ignore background refresh error
      }
    })();
  }, [isBotBusy, screen, active, activeBot]);

  const allChatItems = useMemo(() => {
    if (!activeBot) return [] as Array<Record<string, unknown>>;
    const clearedAfter = clearedMap[activeBot.key] ?? 0;
    // raw history 是旧页，live 投影是新窗口：按 entry id 去重排序；同 id 保留 raw（工具/思考细节更全）。
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of array<Record<string, unknown>>(chatLive?.history)) {
      byId.set(String(item.id), item);
    }
    for (const item of chatHistory) byId.set(String(item.id), item);
    const numericId = (item: Record<string, unknown>) => {
      const id = Number(item.id);
      return Number.isFinite(id) ? id : 0;
    };
    const sorted = [...byId.values()].sort((a, b) => numericId(a) - numericId(b));
    if (chatPending?.botKey === activeBot.key) {
      const alreadyInHistory = parseHistoryEntries(sorted, clearedAfter).some(
        turn => turn.role === 'user' && turn.entryId > chatPending.afterEntryId && turn.text === chatPending.text,
      );
      if (!alreadyInHistory) {
        sorted.push({
          id: chatPending.afterEntryId + 0.5,
          kind: 'pi.user',
          model: [
            {
              role: 'user',
              content: chatPending.text,
              ...(chatPending.attachments?.length ? { attachments: chatPending.attachments.map((id) => ({ id })) } : {}),
              ...(typeof chatPending.submittedAt === 'number' ? { timestamp: chatPending.submittedAt } : {}),
            },
          ],
        });
      }
    }
    return sorted;
  }, [chatHistory, chatLive, activeBot, clearedMap, chatPending]);

  // generation.attribution 缺失但 tools 仍活跃时，用合并历史中最新执行来源判断当前是否协作工作。
  const chatLiveIsCollaborative = Boolean(
    isBotBusy &&
      (liveGenerationAttr?.channel ?? latestEntryChannel(allChatItems, activeBot?.botId)) !== 'primary',
  );
  // 协作工作的流式文本/工具名不渲染进普通聊天忙状态。
  const displayLiveToolName = chatLiveIsCollaborative ? null : activeLiveToolName;
  const displayGeneratingText = chatLiveIsCollaborative ? '' : liveGeneratingText;

  const allChatTurns = useMemo(() => {
    if (!activeBot) return [];
    const clearedAfter = clearedMap[activeBot.key] ?? 0;
    return parseHistoryEntries(allChatItems, clearedAfter, {
      liveTools: recoveringChat ? undefined : array<Record<string, unknown>>(chatLive?.tools),
      isBusy: isBotBusy,
      // 协作（dm/room）生成的流式文本不进普通聊天：隐藏轮由 parser 归轮过滤。
      liveGeneratingText: displayGeneratingText,
      // 当前 Bot 为 self echo（outgoing）判定锚点；live 流式轮的 attribution 由生成帧携带。
      selfBotId: activeBot.botId,
      liveAttribution: liveGenerationAttr,
    });
  }, [allChatItems, chatLive, activeBot, clearedMap, recoveringChat, isBotBusy, liveGeneratingText, liveGenerationAttr, chatLiveIsCollaborative]);

  const activeTurnStartedAt = useMemo(
    () => resolveActiveTurnStartedAt(botActivity),
    [botActivity],
  );

  const visibleTurns = useMemo(() => {
    const q = chatSearchQuery.trim().toLowerCase();
    if (!chatSearchOpen || !q) return allChatTurns;
    return allChatTurns.filter(
      turn =>
        turn.text.toLowerCase().includes(q) ||
        Boolean(
          turn.tools?.some(
            tool =>
              tool.name.toLowerCase().includes(q) ||
              (tool.argSummary && tool.argSummary.toLowerCase().includes(q)) ||
              (tool.output && tool.output.toLowerCase().includes(q)),
          ),
        ),
    );
  }, [allChatTurns, chatSearchOpen, chatSearchQuery]);

  const latestTurnToolCount = visibleTurns.at(-1)?.tools?.length ?? 0;

  // 从私聊/群聊返回聊天时恢复离开前 scrollTop：layout effect 先置位，
  // 同一提交内的自动滚底 effect 看到 pending 标记即跳过这一次。
  const chatScrollRestoreRef = useRef<number | null>(null);
  const chatScrollRestorePending = useRef(false);
  useLayoutEffect(() => {
    if (screen !== 'chat') return;
    const saved = chatScrollRestoreRef.current;
    if (saved === null) return;
    chatScrollRestoreRef.current = null;
    chatScrollRestorePending.current = true;
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = saved;
  }, [screen]);
  useEffect(() => {
    if (screen === 'chat' && chatScrollRef.current) {
      if (chatScrollRestorePending.current) {
        // 本帧是返回恢复，不覆盖刚置回的 scrollTop；后续新消息仍自动滚底。
        chatScrollRestorePending.current = false;
        return;
      }
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [screen, visibleTurns.length, latestTurnToolCount, displayGeneratingText, isBotBusy, displayLiveToolName, failureNotice]);

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
        // 下拉刷新同时刷新群聊列表（静默失败由 hook 自身 error 呈现）。
        Promise.resolve(refreshRoomConversationsRef.current()),
      ]);
      if (results[1].status === 'rejected') setDirectoryError(errorText(results[1].reason));
    } finally {
      hubRefreshRunning.current = false;
      setHubRefreshing(false);
      setPullDistance(0);
    }
  }, [onRefreshConnection, ensureRemoteApi, syncLocalBots, syncRemoteBots]);

  // Step-by-step Back Navigation for Android full-screen back gesture & hardware Back button
  const handleStepBack = useCallback((): boolean => {
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
    if (modelTarget) {
      setModelTarget(null);
      return true;
    }
    if (hubContextMenu) {
      setHubContextMenu(null);
      return true;
    }
    // 群聊/私聊子页的逐级返回优先于隐藏状态的主聊控件关闭（控件虽隐藏但 state 可能仍在）。
    if (screen === 'conversation') {
      if (roomSettingsOpen) {
        setRoomSettingsOpen(false);
        return true;
      }
      setRoomSettingsOpen(false);
      setScreen(scopeReturnScreen);
      return true;
    }
    if (screen === 'dm') {
      if (dmSelectedScopeId) {
        setDmSelectedScopeId(null);
      } else {
        setScreen(dmTarget?.returnScreen ?? 'hub');
      }
      return true;
    }
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
    if (leftDrawerOpen) {
      setLeftDrawerOpen(false);
      return true;
    }
    if (screen === 'bot-avatar') {
      setScreen(avatarReturnScreen);
      return true;
    }
    if (screen === 'bot-soul') {
      setScreen(subPageReturnScreen);
      return true;
    }
    if (screen === 'bot-schedules') {
      if (scheduleEditing !== null) {
        setScheduleEditing(null);
      } else {
        setScreen('bot-profile');
      }
      return true;
    }
    if (screen === 'bot-screen') {
      setScreen('bot-profile');
      return true;
    }
    if (screen === 'bot-edit') {
      if (mustCreatePrimaryBot && editMode === 'create') {
        return true;
      }
      setScreen(editMode === 'create' ? 'hub' : 'bot-profile');
      return true;
    }
    if (screen === 'bot-profile') {
      setScreen(profileReturnScreen);
      return true;
    }
    if (screen === 'chat') {
      chatLoadGeneration.current += 1;
      profileLoadGeneration.current += 1;
      scheduleLoadGeneration.current += 1;
      cancelActiveObservation();
      setChatTopMenuOpen(false);
      setScreen(chatReturnScreen);
      return true;
    }
    if (screen === 'archived-bots') {
      setScreen('settings');
      return true;
    }
    if (screen === 'settings' || screen === 'pending') {
      setScreen('hub');
      return true;
    }
    if (screen === 'hub' && searchQuery.trim()) {
      setSearchQuery('');
      return true;
    }
    return false;
  }, [
    roomDeleteModal,
    botConfirmModal,
    action.busy,
    modelTarget,
    hubContextMenu,
    chatTopMenuOpen,
    composerMenuOpen,
    chatSearchOpen,
    leftDrawerOpen,
    screen,
    roomSettingsOpen,
    avatarReturnScreen,
    subPageReturnScreen,
    profileReturnScreen,
    chatReturnScreen,
    scheduleEditing,
    editMode,
    mustCreatePrimaryBot,
    searchQuery,
    cancelActiveObservation,
    scopeReturnScreen,
    dmSelectedScopeId,
    dmTarget,
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

  // Edge swipe gesture support for Left Hidden Sidebar
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if (!leftDrawerOpen && e.target instanceof Element && e.target.closest('.hub-hero-section')) {
      touchStartRef.current = null;
      return;
    }
    const touch = e.touches[0];
    if (touch) touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    const touch = e.changedTouches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = Math.abs(touch.clientY - start.y);
    if (dy > 60) return;
    if (screen === 'hub' && start.x < 36 && dx > 65) {
      setLeftDrawerOpen(true);
    } else if (leftDrawerOpen && dx < -65) {
      setLeftDrawerOpen(false);
    }
  };

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
    if (!chatDraft) {
      el.style.height = '36px';
    } else {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
    }
  }, [chatDraft, screen]);

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

  /** 本机：上传走 BotHost.call uploadAttachment；归属冻结在发起时的 scope/botId——
   *  切换聊天后完成的上传仍只写原 scope 磁盘草稿，不回填当前 React state。
   *  相同图片 id（content SHA-256，与 backend id 一致）去重，避免 backend duplicate 拒绝。 */
  const uploadLocalImages = useCallback(async (botId: string, scope: string, sources: PickedImageSource[]) => {
    const existing = new Set(readChatDraftAttachments(scope).map((a) => a.id));
    const queued: PickedImageSource[] = [];
    for (const source of sources) {
      const id = await attachmentIdOf(source.data);
      if (existing.has(id)) continue; // 同图重选：附件已在草稿中，跳过上传
      existing.add(id);
      queued.push(source);
    }
    // 去重后总数/总字节上限校验：超限整体拒绝，保留原草稿（不静默丢最早附件）。
    if (readChatDraftAttachments(scope).length + queued.length > IMAGE_MAX_COUNT) {
      throw new ImagePickError('IMAGE_TOO_MANY', t(`最多 ${IMAGE_MAX_COUNT} 张图片，本次未上传。`, `At most ${IMAGE_MAX_COUNT} images; nothing uploaded.`));
    }
    const totalBytes = readChatDraftAttachments(scope).reduce((sum, a) => sum + a.size, 0)
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
      const next = [...readChatDraftAttachments(scope), att];
      writeChatDraftAttachments(scope, next);
      if (currentChatScope.current === scope) setChatDraftAttachments(next);
    }
  }, [t]);

  const pickLocalImages = useCallback((source: 'photos' | 'camera') => {
    if (imageUploading) return;
    setComposerImageError('');
    const bot = activeBot;
    if (!bot || bot.hostKind !== 'local') return;
    const botId = bot.botId;
    const botKey = bot.key;
    const scope = currentChatScope.current;
    if (!scope) { setComposerImageError(t('目标身份尚未就绪，草稿已保留。', 'Target identity unavailable; draft retained.')); return; }
    const handleSources = async (sources: PickedImageSource[]) => {
      if (sources.length === 0) return;
      try {
        await uploadLocalImages(botId, scope, sources);
        if (activeBot?.key === botKey) setComposerImageError('');
      } catch (error) {
        if (activeBot?.key === botKey) setComposerImageError(errorText(error));
      } finally {
        setImageUploading(false);
      }
    };
    setImageUploading(true);
    const release = () => setImageUploading(false);
    if (inTauriUi) {
      void BotHost.pickImages({ source }).then(
        (result) => void handleSources(result.cancelled ? [] : result.images).finally(release),
        (error) => { release(); if (activeBot?.key === botKey) setComposerImageError(errorText(error)); },
      );
      return;
    }
    pickImagesFromInput({
      onPicked: async (files) => {
        const normalized = await Promise.all(files.map((file) => normalizeImageFile(file, file.name)));
        await handleSources(normalized);
      },
      onSettled: release,
    });
  }, [activeBot, imageUploading, inTauriUi, uploadLocalImages, t]);

  const slash = useSlashAutocomplete({
    text: chatDraft,
    // 未确认/待对账的原请求也不得用命令绕过（recovering 不意味着可以清空）。
    disabled: !activeChatScope || Boolean(slashBusy) ||
      Boolean(activeBot && chatPending?.botKey === activeBot.key && chatPending.phase !== 'accepted'),
    onText: text => {
      setChatDraft(text);
      if (currentChatScope.current) writeChatDraft(currentChatScope.current, text);
    },
    onRun: command => void action.run(() => runSlashCommand(command)),
  });
  const anyDrawerOpen = leftDrawerOpen;
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

  return (
    <div
      className={`bot-hub-shell${leftDrawerOpen ? ' drawer-left-active' : ''}${screen === 'bot-screen' ? ' is-fullscreen-computer' : ''}`}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* ==================== SCREEN 1: MAIN HUB (15844.jpg + PanelLeft icon) ==================== */}
      {/* 群聊/私聊子页打开时保持 hub DOM（隐藏不卸载）：返回来源滚动位置不丢。
          用显式 class 而非 hidden 属性，避免 author CSS display 覆盖。 */}
      {(screen === 'hub' || screen === 'conversation' || screen === 'dm') && (
        <main
          className={`hub-main grok-page-enter${anyDrawerOpen ? ' is-scaled' : ''}`}
          aria-label={t('智能体主页', 'Bot Hub')}
          aria-hidden={screen !== 'hub' || undefined}
          style={screen === 'hub' ? undefined : { display: 'none' }}
        >
          <header className="hub-top-bar">
            <button
              type="button"
              className="hub-circle-btn hub-left-trigger"
              aria-label={t('打开左侧边栏', 'Open left sidebar')}
              onClick={() => setLeftDrawerOpen(true)}
            >
              <PanelLeft size={20} strokeWidth={2} />
            </button>

            {(() => {
              const isSpinning = hubRefreshing || centerConn.connecting;
              const isVisible = isSpinning || pullDistance > 4;
              const progress = Math.min(1, pullDistance / PULL_THRESHOLD);
              return (
                <div
                  className={`hub-top-spinner-indicator${isVisible ? ' visible' : ''}${isSpinning ? ' is-refreshing' : ''}${pullDistance >= PULL_THRESHOLD ? ' ready' : ''}`}
                  style={
                    !isSpinning && pullDistance > 0
                      ? {
                          transform: `translateX(-50%) translateY(${Math.min(26, Math.round(pullDistance * 0.36))}px) scale(${0.75 + progress * 0.25})`,
                          opacity: Math.min(1, 0.25 + progress * 0.85),
                        }
                      : undefined
                  }
                  role="status"
                  aria-live="polite"
                  aria-label={
                    centerConn.connecting
                      ? t('正在连接中心…', 'Connecting to center…')
                      : hubRefreshing
                        ? t('正在刷新节点与 Bot…', 'Refreshing nodes and bots…')
                        : pullDistance >= PULL_THRESHOLD
                          ? t('松手立即刷新', 'Release to refresh')
                          : t('下拉刷新', 'Pull down to refresh')
                  }
                >
                  <RefreshCw
                    size={17}
                    strokeWidth={2.3}
                    style={
                      !isSpinning && pullDistance > 0
                        ? { transform: `rotate(${Math.round(pullDistance * 3.8)}deg)` }
                        : undefined
                    }
                  />
                </div>
              );
            })()}

            <button
              type="button"
              className="hub-circle-btn hub-add-btn"
              aria-label={t('新建 Bot', 'New Bot')}
              onClick={() => openCreateBotPage(false)}
            >
              <Plus size={22} strokeWidth={2.2} />
            </button>
          </header>

          <div
            className="hub-scroll-area"
            ref={hubScrollRef}
            onTouchStart={onHubScrollTouchStart}
            onTouchMove={onHubScrollTouchMove}
            onTouchEnd={onHubScrollTouchEnd}
            onTouchCancel={() => { pullTouchRef.current = null; setPullDistance(0); }}
          >
            {/* Local Primary Assistant */}
            <section className="hub-hero-section">
              {primaryBot ? (
                <HubPrimaryHero
                  bot={primaryBot}
                  preset={primaryPreset}
                  label={`${primaryBot.role} · ${primaryBot.hostLabel} - ${t('点击进入文字对话', 'Tap to chat')}`}
                  onOpen={() => openBotChat(primaryBot, 'hub')}
                  onOpenMenu={(position) => setHubContextMenu({ ...position, bot: primaryBot })}
                />
              ) : (
                <button
                  type="button"
                  className="hub-hero-button"
                  onClick={() => {
                    void (async () => {
                      const snap = await ensureLocalHostRunning();
                      const bots = snap?.phase === 'running' ? await syncLocalBots(snap) : [];
                      if (!bots.some(b => b.isPrimary && !b.archivedAt)) {
                        openCreateBotPage(true);
                      }
                    })();
                  }}
                  aria-label={t('创建主智能体', 'Create Primary Bot')}
                >
                  <GrokBotAvatar
                    preset={JARVIS_AVATAR_PRESET}
                    isPrimary
                    starBadge
                    platformBadge={<PlatformLogoIcon platform="android" size={11} />}
                    size={88}
                  />
                  <span className="hub-hero-name">{t('创建主智能体', 'Create Primary Bot')}</span>
                </button>
              )}
            </section>

            {/* Pinned & Regular Bots and Rooms (Archived section moved to Settings) */}
            <section className="hub-bot-list" aria-label={t('智能体列表', 'Bots')}>
              <ErrorNotice
                error={directoryError || (!centerConn.ready ? centerConn.error : '') || chatPins.error || action.error}
                actionLabel={!centerConn.ready && centerConn.status?.error ? t('去设置', 'Settings') : directoryError ? t('刷新', 'Refresh') : undefined}
                onAction={!centerConn.ready && centerConn.status?.error ? () => setScreen('settings') : directoryError ? () => void triggerHubRefresh() : undefined}
                onDismiss={directoryError ? () => setDirectoryError('') : action.error ? () => action.setError('') : undefined}
              />
              {remoteBots.length > 0 && !remoteConnected && (
                <p className="hub-empty-list" role="status">
                  {centerConn.connecting
                    ? t('正在恢复连接，远端设备状态待确认…', 'Reconnecting; remote device status is unknown…')
                    : t('与中心未连接，远端设备状态待确认。下拉可尝试恢复。', 'Disconnected from center. Pull down to check and reconnect.')}
                </p>
              )}
              {roomConversationsError ? (
                <p className="hub-empty-list hub-room-error" role="status">
                  <span>{t('群聊列表加载失败：', 'Failed to load rooms: ')}{roomConversationsError}</span>
                  <button
                    type="button"
                    className="hub-outline-btn"
                    onClick={() => refreshRoomConversations()}
                  >
                    {t('重试', 'Retry')}
                  </button>
                </p>
              ) : null}
              {roomConversationsLoading && filteredMixedHubItems.every(e => !e.room) ? (
                <p className="hub-empty-list" role="status">{t('正在加载群聊…', 'Loading rooms…')}</p>
              ) : null}
              {filteredMixedHubItems.length === 0 ? (
                <div className="hub-empty-list">
                  <p>
                    {searchQuery.trim()
                      ? t('没有匹配的智能体', 'No matching bots')
                      : t('点击上方主助手直接开始对话，或点右上角 + 创建新的智能体', 'Tap the primary assistant above to chat, or + to create a new bot')}
                  </p>
                </div>
              ) : (
                filteredMixedHubItems.map(entry => {
                  if (entry.room) {
                    const room = entry.room;
                    const rowNode = (
                      <ConversationRow
                        key={entry.pinKey}
                        className="hub-bot-row hub-room-row"
                        title={room.title}
                        preview={room.lastPreview || t('暂无消息', 'No messages yet')}
                        timestamp={room.lastActivityAt}
                        badge={t('群聊', 'Group')}
                        pinned={entry.pinned}
                        avatar={
                          <ConversationGroupAvatar
                            members={room.scope.scope.members}
                            bots={knownBots}
                            size={52}
                          />
                        }
                        onOpen={() => openScopeConversation(room, false)}
                        onOpenMenu={(position) => setHubContextMenu({ ...position, room })}
                      />
                    );
                    return entry.pinned ? (
                      <SortablePinnedChat
                        key={entry.pinKey}
                        chatKey={entry.pinKey}
                        keys={visiblePinnedKeys}
                        onReorder={handleReorderPinnedKeys}
                      >
                        {rowNode}
                      </SortablePinnedChat>
                    ) : (
                      rowNode
                    );
                  }
                  const item = entry.bot!;
                  const meta = botMetaMap[item.key];
                  const isPrimaryActive = Boolean(item.isPrimary && !item.archivedAt);
                  const snippet =
                    item.lastPreview ||
                    meta?.lastText ||
                    item.description ||
                    t('点击开始文字对话…', 'Tap to start chatting…');
                  const preset = resolveBotAvatarPreset(botAvatarKey(item), item.role, isPrimaryActive);
                  const rowNode = (
                    <HubBotRow
                      key={entry.pinKey}
                      item={item}
                      preset={preset}
                      isPrimaryActive={isPrimaryActive}
                      snippet={snippet}
                      unread={Boolean(meta?.unread)}
                      timestampMs={entry.sortMs}
                      pinned={entry.pinned}
                      onOpen={() => openBotChat(item, 'hub')}
                      onOpenMenu={(position) => setHubContextMenu({ ...position, bot: item })}
                    />
                  );
                  return entry.pinned ? (
                    <SortablePinnedChat
                      key={entry.pinKey}
                      chatKey={entry.pinKey}
                      keys={visiblePinnedKeys}
                      onReorder={handleReorderPinnedKeys}
                    >
                      {rowNode}
                    </SortablePinnedChat>
                  ) : (
                    rowNode
                  );
                })
              )}
            </section>
          </div>

          <footer className="hub-bottom-bar">
            {unreadCount > 0 && (
              <button
                type="button"
                className="hub-unread-pill"
                onClick={() => {
                  const container = document.querySelector('.hub-scroll-area');
                  container?.scrollBy({ top: 220, behavior: 'smooth' });
                }}
              >
                <ChevronDown size={16} />
                <span>{t(`${unreadCount} 个未读`, `${unreadCount} unread`)}</span>
              </button>
            )}
            <label className="hub-search-box">
              <Search size={18} className="hub-search-icon" />
              <input
                type="search"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={t('搜索', 'Search')}
                aria-label={t('搜索智能体', 'Search bots')}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="hub-search-clear"
                  onClick={() => setSearchQuery('')}
                  aria-label={t('清除搜索', 'Clear search')}
                >
                  <X size={16} />
                </button>
              )}
            </label>
          </footer>
        </main>
      )}

      {/* ==================== SCREEN 2: BOT CHAT VIEW (15845.jpg) ==================== */}
      {/* dm 子页从聊天进入时保持 chat DOM（隐藏不卸载）：返回主聊天滚动位置不丢。 */}
      {(screen === 'chat' || (screen === 'dm' && dmTarget?.returnScreen === 'chat')) && activeBot && (
        <main
          className={`bot-chat-view grok-page-enter${anyDrawerOpen ? ' is-scaled' : ''}`}
          aria-hidden={screen !== 'chat' || undefined}
          style={screen === 'chat' ? undefined : { display: 'none' }}
        >
          {/* Floating Top Header Bar (15845.jpg) */}
          <header className="grok-chat-floating-header">
            <button
              type="button"
              className="grok-floating-circle-btn grok-chat-header-back"
              aria-label={t('返回', 'Back')}
              onClick={() => {
                chatLoadGeneration.current += 1;
                profileLoadGeneration.current += 1;
                scheduleLoadGeneration.current += 1;
                cancelActiveObservation();
                setChatTopMenuOpen(false);
                setScreen(chatReturnScreen);
              }}
            >
              <ArrowLeft size={20} />
            </button>

            {/* Center Bot Pill: tapping opens Bot Profile (15846.jpg / 15867.jpg) */}
            <button
              type="button"
              className="grok-chat-center-pill"
              onClick={() => openBotProfile(activeBot, 'chat')}
              aria-label={t('查看 Bot 资料与设定', 'View Bot profile & settings')}
            >
              <GrokBotAvatar
                preset={resolveBotAvatarPreset(botAvatarKey(activeBot), activeBot.role, activeBot.isPrimary)}
                isPrimary={activeBot.isPrimary}
                busy={isBotBusy}
                size={28}
              />
              <span className="grok-chat-pill-name">{activeBot.role}</span>
              {hasRemoteConfigured && (
                <span
                  className={`hub-bot-host-badge ${activeBot.hostKind}${activeBot.online === false ? ' is-offline' : ''}`}
                >
                  <PlatformLogoIcon platform={activeBot.platform} size={11} />
                  <span className="hub-bot-host-text">{activeBot.hostLabel}</span>
                </span>
              )}
            </button>

            <button
              type="button"
              className="grok-floating-circle-btn grok-chat-header-more"
              aria-label={t('更多选项', 'More options')}
              aria-expanded={chatTopMenuOpen}
              onClick={() => setChatTopMenuOpen(v => !v)}
            >
              <MoreHorizontal size={20} />
            </button>

            {/* 15845.jpg Dropdown Menu Card */}
            {chatTopMenuOpen && (
              <>
                <div className="grok-menu-backdrop" onClick={() => setChatTopMenuOpen(false)} />
                <div className="grok-floating-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => openBotProfile(activeBot, 'chat')}
                  >
                    <User size={19} />
                    <span>{t('查看资料', 'View Profile')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => openBotDmList(activeBot)}
                  >
                    <MessageSquare size={19} />
                    <span>{t('查看 Bot 私聊', 'View Bot DMs')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setChatTopMenuOpen(false);
                      setChatSearchOpen(v => !v);
                    }}
                  >
                    <Search size={19} />
                    <span>{t('在聊天中查找', 'Search in Chat')}</span>
                  </button>
                  {!activeBot.isPrimary && !activeBot.archivedAt && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void handleSetPrimaryBot(activeBot)}
                    >
                      <Star size={19} />
                      <span>{t('设为主智能体', 'Set as Primary Bot')}</span>
                    </button>
                  )}
                  {!activeBot.isPrimary && !activeBot.archivedAt && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => requestArchiveBot(activeBot)}
                    >
                      <Archive size={19} />
                      <span>{t('归档智能体', 'Archive Bot')}</span>
                    </button>
                  )}
                  {Boolean(activeBot.archivedAt) && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void handleUnarchiveBot(activeBot)}
                    >
                      <RotateCcw size={19} />
                      <span>{t('恢复智能体', 'Unarchive Bot')}</span>
                    </button>
                  )}
                  {!activeBot.archivedAt && (
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      onClick={() => {
                        const scope = activeChatScope;
                        void runSlashCommand('/clear').catch(error => {
                          if (currentChatScope.current === scope) setClearNotice(errorText(error));
                        });
                      }}
                    >
                      <Trash2 size={19} />
                      <span>{t('清空当前对话', 'Clear History')}</span>
                    </button>
                  )}
                  {!activeBot.isPrimary && (
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      onClick={() => requestDeleteBot(activeBot)}
                    >
                      <Trash2 size={19} />
                      <span>{t('永久删除智能体', 'Permanently Delete Bot')}</span>
                    </button>
                  )}
                </div>
              </>
            )}
          </header>

          {chatSearchOpen && (
            <div className="grok-chat-search-strip">
              <Search size={16} />
              <input
                type="search"
                value={chatSearchQuery}
                onChange={e => setChatSearchQuery(e.target.value)}
                placeholder={t('查找聊天内容…', 'Search messages…')}
                autoFocus
              />
              <button
                type="button"
                onClick={() => {
                  setChatSearchOpen(false);
                  setChatSearchQuery('');
                }}
              >
                <X size={16} />
              </button>
            </div>
          )}

          <section
            className="bot-chat-messages"
            ref={chatScrollRef}
            onClick={() => {
              if (composerMenuOpen) setComposerMenuOpen(false);
              if (chatTopMenuOpen) setChatTopMenuOpen(false);
            }}
          >
            {visibleTurns.length === 0 && !displayGeneratingText ? (
              <div className="bot-chat-empty">
                <button
                  type="button"
                  className="bot-chat-empty-avatar-btn"
                  onClick={() => openBotProfile(activeBot)}
                >
                  <GrokBotAvatar
                    preset={resolveBotAvatarPreset(botAvatarKey(activeBot), activeBot.role, activeBot.isPrimary)}
                    isPrimary={activeBot.isPrimary}
                    starBadge={activeBot.isPrimary}
                    platformBadge={
                      activeBot.isPrimary ? <PlatformLogoIcon platform={activeBot.platform} size={11} /> : undefined
                    }
                    size={76}
                  />
                </button>
                <h2>{activeBot.role}</h2>
                <p>
                  {activeBot.description ||
                    t(
                      '点击顶部名称可管理头像、人设、定时任务与电脑屏幕。',
                      'Tap the top pill to manage avatar, persona, schedules, and computer screen.',
                    )}
                </p>
              </div>
            ) : (
              visibleTurns.map((turn, turnIdx) => {
                const isLastAssistantTurn =
                  turn.role === 'assistant' && turnIdx === visibleTurns.length - 1;
                const showTurnDuration =
                  turn.role === 'assistant' &&
                  typeof turn.durationMs === 'number' &&
                  turn.durationMs > 0 &&
                  !(isLastAssistantTurn && isBotBusy);
                const attribution = turn.attribution;
                return (
                  <article
                    key={turn.id}
                    className={`bot-chat-bubble ${turn.role}${turn.isStreaming ? ' streaming' : ''}`}
                  >
                    {attribution && attribution.kind !== 'host' && (
                      <MessageAttribution
                        attribution={attribution}
                        className="bot-chat-attribution"
                      />
                    )}
                    {turn.thinking && (
                      <details className="bot-chat-thinking">
                        <summary>{t('思考过程', 'Thinking')}</summary>
                        <pre>{turn.thinking}</pre>
                      </details>
                    )}
                    {turn.tools && turn.tools.length > 0 && (
                      <TurnToolCallsSection
                        tools={turn.tools}
                        botKey={activeBot?.key ?? 'chat'}
                        isBotBusy={isBotBusy}
                        disabled={Boolean(activeBot?.archivedAt)}
                        onSubmitQuestionnaire={submitQuestionnaire}
                        t={t}
                      />
                    )}
                    {turn.role === 'user' && turn.attachments && turn.attachments.length > 0 ? (
                      <SentAttachments
                        attachments={turn.attachments}
                        fetcher={activeBot?.hostKind === 'remote' && activeBot.remoteIdentity && remoteClientRef.current
                          ? remoteAttachmentFetcher(remoteClientRef.current.api, activeBot.remoteIdentity, activeBot.botId)
                          : localAttachmentFetcher}
                      />
                    ) : null}
                    {turn.text && <Markdown text={turn.text} />}
                    <ErrorNotice
                      compact
                      error={turn.error === 'model_error'
                        ? t('模型生成失败，请重试或检查模型配置。', 'Model generation failed. Retry or check the model configuration.')
                        : turn.error}
                      actionLabel={t('模型设置', 'Model Settings')}
                      onAction={() => openBotProfile(activeBot)}
                    />
                    {showTurnDuration && (
                      <div className="bot-chat-turn-meta" aria-label={formatTurnDuration(turn.durationMs!, t)}>
                        <svg className="bot-chat-turn-clock" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.5" />
                          <path d="M8 5v3.25l2.1 1.35" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span>{formatTurnDuration(turn.durationMs!, t)}</span>
                      </div>
                    )}
                  </article>
                );
              })
            )}
            <GrokBotWorkingSlot
              key={activeBot.key}
              botKey={activeBot.key}
              preset={resolveBotAvatarPreset(botAvatarKey(activeBot), activeBot.role, activeBot.isPrimary)}
              isBusy={isBotBusy}
              isSending={chatPending?.botKey === activeBot.key && chatPending.phase === 'sending'}
              isRecovering={chatPending?.botKey === activeBot.key && chatPending.phase === 'recovering'}
              isStreaming={Boolean(displayGeneratingText)}
              activeToolName={displayLiveToolName}
              hasThinking={Boolean(
                visibleTurns[visibleTurns.length - 1]?.role === 'assistant' &&
                  visibleTurns[visibleTurns.length - 1]?.thinking &&
                  !displayGeneratingText,
              )}
              queuedCount={chatLive?.queuedCount ?? 0}
              activity={botActivity}
              hasError={Boolean(failureNotice) || (chatReceipt?.status === 'unanswered' && !receiptUserCancelled)}
              startedAt={activeTurnStartedAt}
              t={t}
            />
            <ErrorNotice
              error={failureNotice || (!centerConn.ready && centerConn.status?.error ? centerConn.error : '')}
              actionLabel={failureNotice ? t('检查配置', 'Check Settings') : !centerConn.ready && centerConn.status?.error ? t('去连接', 'Connect') : undefined}
              onAction={failureNotice ? () => openBotProfile(activeBot) : !centerConn.ready && centerConn.status?.error ? () => setScreen('settings') : undefined}
            />
            {((chatLoadError && !(centerConn.status?.state === 'disconnected' && centerConn.status.error)) || (chatPending?.botKey === activeBot.key && chatPending.phase === 'recovering')) && (
              <div className="bot-chat-system-notice" role="status">
                {chatPending?.phase === 'recovering' ? t('发送结果待确认，保留原请求 ID；不会自动重发。', 'Send result unconfirmed; retaining the original request ID without resending.') : activeBot.online === false ? remoteConnected ? t('目标节点离线，上线后自动恢复。', 'Target offline; restoring when it returns.') : t('连接已中断，远端设备状态待确认。', 'Connection interrupted; remote device status is unknown.') : chatLoadError}
                {chatPending?.phase === 'recovering' && activeBot.hostKind === 'local' && <button type="button" className="hub-outline-btn" onClick={() => setChatResumeEpoch(value => value + 1)}>{t('按原 ID 对账', 'Reconcile ID')}</button>}
              </div>
            )}
            {chatTurnAdmission && chatPending?.botKey === activeBot.key && (chatReceipt?.status === undefined || chatReceipt.status === 'queued') && (
              <div className="bot-chat-system-notice" role="status">
                {admissionStatusText}
                {chatTurnAdmission.phase === 'failed' && (activeBot.hostKind === 'local'
                  ? <button type="button" className="hub-outline-btn" onClick={() => void retryAdmission()}>{t('按原 ID 重试', 'Retry same ID')}</button>
                  : <button type="button" className="hub-outline-btn" onClick={() => void retryRemoteAdmission()}>{t('按原 ID 重试', 'Retry same ID')}</button>
                )}
              </div>
            )}
            {clearNotice && (
              <div className="bot-chat-system-notice" role="status">
                {clearNotice}
              </div>
            )}
          </section>

          {/* 15845.jpg / 15866.jpg Bottom Composer Bar */}
          <footer className="grok-chat-composer-area">
            {offlineNotice?.botKey === activeBot.key && (
              <FloatingPillToast
                message={offlineNotice.text}
                tone="warning"
                onDismiss={() => setOfflineNotice(undefined)}
              />
            )}
            {activeBot.archivedAt ? (
              <div className="grok-card-group grok-archived-chat-banner">
                <span className="grok-archived-chat-banner-text">
                  {t(
                    `该智能体已归档（14 天保留期剩余 ${formatArchivedRemainingDays(activeBot.archivedAt)} 天），当前为只读历史`,
                    `Archived (${formatArchivedRemainingDays(activeBot.archivedAt)}d left of 14d retention) · Read-only history`,
                  )}
                </span>
                <div className="grok-archived-chat-banner-actions">
                  <button
                    type="button"
                    className="grok-done-pill-btn"
                    disabled={action.busy}
                    onClick={() => void handleUnarchiveBot(activeBot)}
                  >
                    {t('立即恢复', 'Restore')}
                  </button>
                  {!activeBot.isPrimary && (
                    <button
                      type="button"
                      className="hub-outline-btn danger"
                      disabled={action.busy}
                      onClick={() => requestDeleteBot(activeBot)}
                    >
                      {t('永久删除智能体', 'Permanently Delete')}
                    </button>
                  )}
                </div>
              </div>
            ) : activeBot.hostKind === 'remote' && activeBot.remoteIdentity && remoteClientRef.current ? (
              <RemotePendingComposer
                key={activeBot.key}
                api={remoteClientRef.current.api}
                identity={activeBot.remoteIdentity}
                botId={activeBot.botId}
                botRole={activeBot.role}
                isBotBusy={isBotBusy}
                online={remoteConnected && activeBot.online !== false}
                onOffline={() => setOfflineNotice({ botKey: activeBot.key, text: t('目标离线，草稿已保留。', 'Target offline; draft retained.') })}
                composerMenuOpen={composerMenuOpen}
                onToggleComposerMenu={() => setComposerMenuOpen(v => !v)}
                onOpenProfile={() => {
                  setComposerMenuOpen(false);
                  openBotProfile(activeBot);
                }}
                onRunCommand={runSlashCommand}
                commandBusy={Boolean(slashBusy)}
                canStop={canStopBot}
                stopping={isStoppingBot}
                onAbort={async () => {
                  await requestStopBot(activeBot);
                }}
                pending={chatPending?.scopeKey === activeChatScope ? chatPending : undefined}
                fallbackDraft={chatDraft}
                onFallbackTransferred={() => {
                  if (currentChatScope.current === activeChatScope) {
                    setChatDraft('');
                    setChatDraftAttachments([]);
                    setComposerImageError('');
                  }
                  writeChatDraft(activeChatScope, '');
                  writeChatDraftAttachments(activeChatScope, []);
                }}
                blocked={chatPending?.scopeKey === activeChatScope && chatPending.phase === 'recovering'}
                onStarted={(requestId, text, draft) => {
                  const old = pendingByBot.current.get(activeChatScope)?.pending;
                  const pending: ChatPending = old?.requestId === requestId ? old : {
                    botKey: activeBot.key, scopeKey: activeChatScope, requestId, text, draft, phase: 'sending',
                    submittedAt: Date.now(),
                    afterEntryId: Math.max(maxHistoryEntryId(chatHistory), Number(chatLive?.lastEntryId) || 0, clearedMap[activeBot.key] ?? 0),
                  };
                  if (currentChatScope.current === activeChatScope) chatSubmissionRef.current = pending;
                  const entry = pendingByBot.current.get(activeChatScope);
                  updatePending({ pending, receipt: entry?.pending.requestId === requestId ? entry.receipt : undefined }, false);
                }}
                onPersist={requestId => {
                  const entry = pendingByBot.current.get(activeChatScope);
                  return Boolean(activeChatScope && entry?.pending.requestId === requestId && updatePending(entry));
                }}
                onQueued={(requestId, pendingId) => {
                  const entry = pendingByBot.current.get(activeChatScope);
                  if (entry?.pending.requestId === requestId) updatePending({ ...entry, pending: { ...entry.pending, pendingId } });
                }}
                onAccepted={receipt => {
                  const entry = pendingByBot.current.get(activeChatScope);
                  if (entry?.pending.requestId === receipt.requestId) updatePending({ pending: { ...entry.pending, phase: 'accepted', admission: (receipt as TurnAdmissionCarrier).admission ?? null }, receipt });
                }}
                onUnconfirmed={requestId => {
                  const entry = pendingByBot.current.get(activeChatScope);
                  if (entry?.pending.requestId === requestId && !entry.receipt) updatePending({ ...entry, pending: { ...entry.pending, phase: 'recovering' } });
                }}
                onNotSent={requestId => removePending(activeChatScope, requestId)}
              />
            ) : <>
            <ErrorNotice error={stopError || action.error} compact onDismiss={() => { setStopError(''); action.setError(''); }} />
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
                  onClick={() => {
                    setComposerMenuOpen(false);
                    openBotProfile(activeBot);
                  }}
                >
                  <User size={18} />
                  <span>{t('查看 Bot 资料与设定', 'View Bot Profile & Settings')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!activeChatScope || chatDraftAttachments.length >= IMAGE_MAX_COUNT || imageUploading}
                  onClick={() => {
                    setComposerMenuOpen(false);
                    pickLocalImages('photos');
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
                    disabled={!activeChatScope || chatDraftAttachments.length >= IMAGE_MAX_COUNT || imageUploading}
                    onClick={() => {
                      setComposerMenuOpen(false);
                      pickLocalImages('camera');
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                    <span>{t('拍照', 'Camera')}</span>
                  </button>
                )}
                <button type="button" role="menuitem" className="danger" onClick={() => void action.run(() => runSlashCommand('/clear'))}>
                  <Trash2 size={18} />
                  <span>{t('清空当前对话历史 (/clear)', 'Clear conversation history (/clear)')}</span>
                </button>
              </div>
            )}

            {composerImageError ? <ErrorNotice compact error={composerImageError} onDismiss={() => setComposerImageError('')} /> : null}
            {chatDraftAttachments.length > 0 ? (
              <div className="attachments" role="group" aria-label={t('附件', 'Attachments')}>
                {chatDraftAttachments.map((att, index) => (
                  <ImageAttachmentThumb
                    key={att.id}
                    attachment={att}
                    fetcher={localAttachmentFetcher}
                    disabled={!activeChatScope || Boolean(slashBusy)}
                    onRemove={() => {
                      const next = chatDraftAttachments.filter((_, i) => i !== index);
                      setChatDraftAttachments(next);
                      if (currentChatScope.current && !writeChatDraftAttachments(currentChatScope.current, next)) setClearNotice(t('草稿未能保存，请保持页面打开。', 'Draft could not be saved; keep this page open.'));
                    }}
                    t={t}
                  />
                ))}
              </div>
            ) : null}

            <div className="grok-composer-row">
              <button
                type="button"
                className={`grok-composer-plus-circle${composerMenuOpen ? ' active' : ''}`}
                aria-label={t('更多操作', 'More actions')}
                aria-expanded={composerMenuOpen}
                onClick={() => setComposerMenuOpen(v => !v)}
              >
                <Plus size={22} />
              </button>

              <div className="grok-composer-pill">
                <textarea
                  ref={composerTextareaRef}
                  rows={1}
                  className={chatDraft ? 'has-text' : 'is-empty'}
                  value={chatDraft}
                  disabled={!activeChatScope || Boolean(slashBusy)}
                  {...slash.textareaProps}
                  onChange={e => { setChatDraft(e.target.value); if (currentChatScope.current && !writeChatDraft(currentChatScope.current, e.target.value)) setClearNotice(t('草稿未能保存，请保持页面打开。', 'Draft could not be saved; keep this page open.')); }}
                  placeholder={
                    activeBot.role.length > 8
                      ? t('发消息…', 'Message…')
                      : t(`向 ${activeBot.role} 发消息…`, `Message ${activeBot.role}…`)
                  }
                  aria-label={t('消息', 'Message')}
                  onKeyDown={e => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (slash.onKeyDown(e)) return;
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void sendMessage();
                    }
                  }}
                />

                {activeBot.hostKind === 'local' && (
                  <button
                    type="button"
                    className={`grok-composer-mic-inline${voiceCapturing ? ' recording' : ''}`}
                    aria-label={voiceCapturing ? t('完成语音', 'Finish voice') : t('语音输入', 'Voice input')}
                    onClick={() =>
                      action.run(async () => {
                        if (voiceCapturing) {
                          await BotHost.finishVoice();
                          setVoiceCapturing(undefined);
                        } else {
                          const submission = {
                            botKey: activeBot.key,
                            requestId: uuid(),
                            afterEntryId: Math.max(
                              maxHistoryEntryId(chatHistory), Number(chatLive?.lastEntryId) || 0,
                              clearedMap[activeBot.key] ?? 0,
                            ),
                          };
                          chatSubmissionRef.current = submission;
                          setChatReceipt(undefined);
                          const snap = await ensureLocalHostRunning();
                          if (!snap || snap.phase !== 'running' || chatSubmissionRef.current !== submission) return;
                          const targetBotId = activeBot.botId;
                          const cap = { botId: targetBotId, requestId: submission.requestId };
                          setVoiceCapturing(cap);
                          await BotHost.startVoice(cap);
                        }
                      })
                    }
                  >
                    <Mic size={19} />
                  </button>
                )}

                {chatDraft.trim() || chatDraftAttachments.length > 0 ? (
                  <button
                    type="button"
                    className="grok-composer-action-pill send"
                    aria-label={t('发送', 'Send')}
                    disabled={action.busy || Boolean(slashBusy) || imageUploading || (chatPending?.botKey === activeBot.key && chatPending.phase === 'recovering')}
                    onClick={() => void sendMessage()}
                  >
                    <ArrowUp size={18} />
                  </button>
                ) : !canStopBot && !isBotBusy ? (
                  <button
                    type="button"
                    className="grok-composer-action-pill voice"
                    aria-label={t('语音对话', 'Voice mode')}
                    onClick={() => openBotProfile(activeBot)}
                  >
                    <AudioLines size={18} />
                  </button>
                ) : null}
              </div>

              {/* 停止与发送并存：草稿/附件/发送准备/失败受理都可停止；不被 action.busy/上传/草稿锁禁用，只防重复。 */}
              {canStopBot || isStoppingBot ? (
                <button
                  type="button"
                  className="grok-composer-action-pill stop"
                  aria-label={t('停止此 Bot', 'Stop this bot')}
                  disabled={isStoppingBot}
                  onClick={() => {
                    if (isStoppingBot) return;
                    setStopError('');
                    requestStopBot(activeBot).then(
                      () => setStopError(''),
                      error => setStopError(errorText(error)),
                    );
                  }}
                >
                  {isStoppingBot ? <RefreshCw size={14} className="grok-spin" /> : <Square size={15} />}
                </button>
              ) : null}
            </div>
            </>}
          </footer>
        </main>
      )}

      {/* ==================== SCREEN 3: BOT PROFILE VIEW (15867.jpg) ==================== */}
      {screen === 'bot-profile' && activeBot && (
        <main className="grok-subpage grok-page-enter">
          <header className="grok-subpage-topbar">
            <button
              type="button"
              className="grok-floating-circle-btn"
              aria-label={t('返回', 'Back')}
              onClick={() => setScreen(profileReturnScreen)}
            >
              <ArrowLeft size={20} />
            </button>
            <div className="grok-subpage-actions">
              <button
                type="button"
                className="grok-floating-circle-btn"
                aria-label={t('编辑 Bot', 'Edit Bot')}
                onClick={() => openBotEdit(activeBot)}
              >
                <MoreHorizontal size={20} />
              </button>
            </div>
          </header>

          <div className="grok-subpage-scroll">
            <section className="grok-profile-hero">
              <button
                type="button"
                className="grok-profile-avatar-btn"
                onClick={() =>
                  openAvatarPicker(
                    'bot-profile',
                    resolveBotAvatarPreset(botAvatarKey(activeBot), activeBot.role, activeBot.isPrimary),
                  )
                }
                aria-label={t('更换头像', 'Change avatar')}
              >
                <GrokBotAvatar
                  preset={resolveBotAvatarPreset(botAvatarKey(activeBot), activeBot.role, activeBot.isPrimary)}
                  isPrimary={activeBot.isPrimary}
                  starBadge={activeBot.isPrimary}
                  platformBadge={
                    activeBot.isPrimary ? <PlatformLogoIcon platform={activeBot.platform} size={11} /> : undefined
                  }
                  size={104}
                />
              </button>
              <h1 className="grok-profile-title">{activeBot.role}</h1>
              {activeBot.description && (
                <p className="grok-profile-subtitle">{activeBot.description}</p>
              )}
              <button
                type="button"
                className="grok-profile-edit-pill"
                onClick={() => openBotEdit(activeBot)}
              >
                {t('编辑', 'Edit')}
              </button>
            </section>

            {/* Grouped Card 1: Capabilities & Computer (15867.jpg style) */}
            <section className="grok-card-group">
              <button
                type="button"
                className="grok-card-row"
                onClick={() => openModelPickerSheet('bot-profile')}
                disabled={!getOrCreateRemoteClient || !remoteConnected || !remoteIdentity || (activeBot.hostKind === 'local' && !localHost?.deviceId)}
              >
                <Cpu size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('模型', 'Model')}</span>
                <span className="grok-row-value grok-row-value-path">
                  {getOrCreateRemoteClient ? t('设置', 'Settings') : t('请在独立助手中设置 Bot 模型', 'Set the bot model in the standalone assistant')}
                </span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>

              <button
                type="button"
                className="grok-card-row"
                onClick={() => openModelPickerSheet('bot-profile', 'capabilities')}
                disabled={!getOrCreateRemoteClient || !remoteConnected || !remoteIdentity || (activeBot.hostKind === 'local' && !localHost?.deviceId)}
              >
                <Puzzle size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('插件 / 技能 / MCP', 'Plugins / Skills / MCP')}</span>
                <span className="grok-row-value grok-row-value-path">
                  {getOrCreateRemoteClient ? t('设置', 'Settings') : t('请在独立助手中设置 Bot 能力', 'Set bot capabilities in the standalone assistant')}
                </span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>

              <button
                type="button"
                className="grok-card-row"
                onClick={() => openModelPickerSheet('bot-profile', 'advanced')}
                disabled={!getOrCreateRemoteClient || !remoteConnected || !remoteIdentity || (activeBot.hostKind === 'local' && !localHost?.deviceId)}
              >
                <Settings size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('高级设置', 'Advanced Settings')}</span>
                <span className="grok-row-value grok-row-value-path">
                  {getOrCreateRemoteClient ? t('Code Mode · 覆盖策略', 'Code Mode · Overrides') : t('请在独立助手中设置', 'Configure in standalone assistant')}
                </span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>

              <button
                type="button"
                className="grok-card-row"
                onClick={() => {
                  setSubPageReturnScreen('bot-profile');
                  setScreen('bot-soul');
                }}
              >
                <Sparkles size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('灵魂文档', 'Persona')}</span>
                <span className="grok-row-value">
                  {soulDraft.trim() ? t('已配置', 'Configured') : t('未设置', 'Not set')}
                </span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>

              <button
                type="button"
                className="grok-card-row"
                onClick={() => openBotSchedules(activeBot)}
              >
                <Clock size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('定时任务', 'Schedules')}</span>
                <span className="grok-row-value">
                  {(() => {
                    const count =
                      botMetaMap[activeBot.key]?.scheduleCount ??
                      botScheduleState.tasks.filter(x => x.enabled !== false).length;
                    return count > 0 ? t(`${count} 个已开启`, `${count} active`) : '';
                  })()}
                </span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>

              <button
                type="button"
                className="grok-card-row"
                onClick={() => void openCenterManagement()}
              >
                <Brain size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('长期记忆', 'Memory')}</span>
                <span className="grok-row-value">{t('在中心管理中打开', 'Opens Center management')}</span>
                <ExternalLink size={16} className="grok-row-chevron" />
              </button>

              <div className="grok-card-row no-active">
                <FolderOpen size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('资料库', 'Files')}</span>
                <span className="grok-row-value grok-row-value-path">
                  {(activeBot.cwd || localHost?.workspace || '/workspace').split(/[\\/]/).filter(Boolean).pop() ||
                    '/workspace'}
                </span>
              </div>

              <button
                type="button"
                className="grok-card-row"
                onClick={() => setScreen('bot-screen')}
              >
                <Monitor size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('电脑', 'Computer')}</span>
                <span className="grok-row-value">{isBotBusy ? t('运行中', 'Active') : t('空闲', 'Idle')}</span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>
            </section>

            {/* Grouped Card 2: Notification Toggle (15867.jpg) */}
            <section className="grok-card-group">
              <div className="grok-card-row no-active">
                <span className="grok-row-label">{t('通知', 'Notifications')}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={botMetaMap[activeBot.key]?.notifyEnabled !== false}
                  className={`grok-toggle-switch${botMetaMap[activeBot.key]?.notifyEnabled !== false ? ' checked' : ''}`}
                  style={
                    botMetaMap[activeBot.key]?.notifyEnabled !== false
                      ? { backgroundColor: resolveBotAvatarPreset(botAvatarKey(activeBot), activeBot.role, activeBot.isPrimary).color }
                      : undefined
                  }
                  onClick={() =>
                    updateBotMeta(activeBot.key, {
                      notifyEnabled: botMetaMap[activeBot.key]?.notifyEnabled === false,
                    })
                  }
                >
                  <span className="grok-toggle-knob" />
                </button>
              </div>
            </section>
            <p className="grok-card-footnote">
              {t('Bot 完成任务或等你处理时通知你', 'Notify you when the Bot finishes work or needs your input')}
            </p>

            {/* Grouped Card 3: Primary Bot Switch, Archive & Delete Lifecycle */}
            <div className="grok-field-section" style={{ marginTop: 12 }}>
              <label className="grok-section-label">{t('节点与生命周期管理', 'Lifecycle Management')}</label>
              <section className="grok-card-group">
                {activeBot.isPrimary ? (
                  <div className="grok-card-row no-active">
                    <Star size={19} className="grok-row-icon" />
                    <span className="grok-row-label">
                      {t('当前为主智能体（切换主智能体后可归档或删除）', 'Current Primary Bot (switch primary to archive/delete)')}
                    </span>
                  </div>
                ) : (
                  <>
                    {!activeBot.archivedAt && (
                      <button
                        type="button"
                        className="grok-card-row"
                        disabled={action.busy}
                        onClick={() => void handleSetPrimaryBot(activeBot)}
                      >
                        <Star size={19} className="grok-row-icon" />
                        <span className="grok-row-label">{t('设为主智能体', 'Set as Primary Bot')}</span>
                        <ChevronRight size={18} className="grok-row-chevron" />
                      </button>
                    )}
                    {!activeBot.archivedAt ? (
                      <button
                        type="button"
                        className="grok-card-row"
                        disabled={action.busy}
                        onClick={() => requestArchiveBot(activeBot)}
                      >
                        <Archive size={19} className="grok-row-icon" />
                        <span className="grok-row-label">{t('归档智能体', 'Archive Bot')}</span>
                        <span className="grok-row-value">{t('14 天后自动清理', '14d auto-delete')}</span>
                        <ChevronRight size={18} className="grok-row-chevron" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="grok-card-row"
                        disabled={action.busy}
                        onClick={() => void handleUnarchiveBot(activeBot)}
                      >
                        <RotateCcw size={19} className="grok-row-icon" />
                        <span className="grok-row-label">{t('恢复智能体（解除归档）', 'Unarchive Bot')}</span>
                        <span className="grok-row-value">
                          {t(`剩余 ${formatArchivedRemainingDays(activeBot.archivedAt)} 天`, `${formatArchivedRemainingDays(activeBot.archivedAt)}d left`)}
                        </span>
                        <ChevronRight size={18} className="grok-row-chevron" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="grok-card-row danger-text"
                      disabled={action.busy}
                      onClick={() => requestDeleteBot(activeBot)}
                    >
                      <Trash2 size={19} />
                      <span className="grok-row-label">{t('永久删除智能体', 'Permanently Delete Bot')}</span>
                    </button>
                  </>
                )}
              </section>
              <ErrorNotice error={action.error} onDismiss={() => action.setError('')} />
            </div>
          </div>
        </main>
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
          onBack={() => setScreen('bot-profile')}
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

      {/* ==================== SCREEN 4: EDIT / CREATE BOT VIEW (15847.jpg) ==================== */}
      {screen === 'bot-edit' && (
        <main className="grok-subpage grok-page-enter">
          <header className="grok-subpage-topbar">
            {mustCreatePrimaryBot && editMode === 'create' ? (
              <span style={{ width: 40 }} />
            ) : (
              <button
                type="button"
                className="grok-floating-circle-btn"
                aria-label={t('返回', 'Back')}
                onClick={() => setScreen(editMode === 'create' ? 'hub' : 'bot-profile')}
              >
                <ArrowLeft size={20} />
              </button>
            )}
            <h2 className="grok-subpage-header-title">
              {editMode === 'create'
                ? mustCreatePrimaryBot || editMakePrimary
                  ? t('创建主智能体', 'Create Primary Bot')
                  : t('新建 Bot', 'New Bot')
                : t('编辑 Bot', 'Edit Bot')}
            </h2>
            <button
              type="button"
              className="grok-done-pill-btn"
              disabled={action.busy || !editName.trim()}
              onClick={() => void handleSaveBotEdit()}
            >
              {action.busy ? t('保存中', 'Saving') : t('完成', 'Done')}
            </button>
          </header>

          <div className="grok-subpage-scroll">
            {mustCreatePrimaryBot && editMode === 'create' && (
              <div className="grok-field-section">
                <section className="grok-card-group" style={{ padding: '12px 14px' }}>
                  <strong style={{ display: 'block', marginBottom: 4 }}>
                    {t('当前设备尚未创建主智能体', 'Primary Bot Required')}
                  </strong>
                  <span style={{ fontSize: '0.85rem', opacity: 0.82 }}>
                    {t(
                      '每台设备至少需要一个主智能体。请先创建本机主智能体后再进入主页。',
                      'Every device requires at least one primary bot. Create one to enter the hub.',
                    )}
                  </span>
                </section>
              </div>
            )}
            {editMode === 'create' && createAttempt && (
              <div className="grok-field-section">
                <section className="grok-card-group grok-pending-freeze-card">
                  <div className="grok-pending-freeze-head">
                    <span className="grok-pending-freeze-badge">{t('创建回执未确认', 'Creation Unconfirmed')}</span>
                    <code className="grok-pending-freeze-id">{createAttempt.requestId.slice(0, 12)}</code>
                  </div>
                  <p className="grok-pending-freeze-desc">
                    {t(
                      '上次创建请求的回执尚未确认，请先按原请求 ID 对账，避免重复创建。',
                      'Previous creation receipt is unconfirmed. Reconcile the original request ID first.',
                    )}
                  </p>
                  <div className="grok-pending-freeze-actions">
                    <button
                      type="button"
                      className="grok-done-pill-btn"
                      disabled={action.busy}
                      onClick={() =>
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
                            throw new Error(
                              t(
                                '尚未找到原请求，保持原 ID，不能重新创建',
                                'Original request not found; retain its ID and do not recreate',
                              ),
                            );
                          }
                          setCreateAttempt(null);
                          setScreen('hub');
                        })
                      }
                    >
                      {t('按原 ID 对账', 'Reconcile Original ID')}
                    </button>
                    <button
                      type="button"
                      className="hub-outline-btn"
                      onClick={() => setCreateAttempt(null)}
                    >
                      {t('清除冻结状态', 'Clear Freeze')}
                    </button>
                  </div>
                </section>
              </div>
            )}
            {/* Hero Avatar with Pencil Badge (15847.jpg) */}
            <section className="grok-profile-hero compact">
              <button
                type="button"
                className="grok-edit-avatar-wrap"
                onClick={() => openAvatarPicker('bot-edit', editAvatarPreset)}
                aria-label={t('选择头像', 'Choose avatar')}
              >
                <GrokBotAvatar preset={editAvatarPreset} size={104} />
                <span className="grok-avatar-pencil-badge">
                  <Pencil size={16} />
                </span>
              </button>
            </section>

            <div className="grok-field-section">
              <label className="grok-section-label">{t('名称', 'Name')}</label>
              <div className="grok-card-group">
                <input
                  className="grok-card-input"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  placeholder={t('输入 Bot 名称', 'Enter Bot name')}
                />
              </div>
            </div>

            <div className="grok-field-section">
              <label className="grok-section-label">{t('标题', 'Subtitle')}</label>
              <div className="grok-card-group">
                <input
                  className="grok-card-input"
                  value={editSubtitle}
                  onChange={e => setEditSubtitle(e.target.value)}
                  placeholder={t('描述 Bot 的用途（可选）', 'Describe what this Bot does (optional)')}
                />
              </div>
            </div>

            <div className="grok-field-section">
              <label className="grok-section-label">{t('工作目录', 'Working directory')}</label>
              <div className="grok-card-group">
                <input
                  className="grok-card-input"
                  value={editCwd}
                  onChange={e => { editCwdDirtyRef.current = true; setEditCwd(e.target.value); }}
                  placeholder={editMode === 'create'
                    ? t('目标主机上的绝对路径（留空用默认工作区）', 'Absolute path on the target host (blank uses default workspace)')
                    : t('目标 Host 上的绝对路径；空闲后生效', 'Absolute path on the target Host; applies when idle')}
                />
                {editMode === 'edit' && (
                  <p className="secondary" style={{ margin: '0 18px 12px' }}>
                    {t(
                      '保存到中心后在该 Bot 空闲时生效；运行中的任务保持原目录，不会移动文件。',
                      'Saved to the center and applied when this Bot is idle; running work keeps its directory and no files are moved.',
                    )}
                  </p>
                )}
                {editMode === 'edit' && editCwdError && (
                  <div className="grok-card-row no-active">
                    <span className="grok-row-label" style={{ color: 'var(--danger, #c0392b)' }}>{editCwdError}</span>
                    <button
                      type="button"
                      className="hub-outline-btn"
                      disabled={action.busy || !activeBot}
                      onClick={() => activeBot && void loadEditCwd(activeBot)}
                    >
                      {t('重新读取', 'Reload')}
                    </button>
                  </div>
                )}
                {editMode === 'edit' && !editCwdError && editCwdRevision === null && (
                  <p className="secondary" style={{ margin: '0 18px 12px' }}>
                    {t('正在读取中心修订…', 'Loading the center revision…')}
                  </p>
                )}
              </div>
            </div>

            <div className="grok-field-section">
              <label className="grok-section-label">{t('外观', 'Appearance')}</label>
              <div className="grok-card-group">
                <button
                  type="button"
                  className="grok-card-row"
                  onClick={() => openAvatarPicker('bot-edit', editAvatarPreset)}
                >
                  <span className="grok-row-label">{t('头像', 'Avatar')}</span>
                  <span className="grok-row-value" />
                  <ChevronRight size={18} className="grok-row-chevron" />
                </button>
              </div>
            </div>

            {editMode === 'create' && hasRemoteConfigured && !mustCreatePrimaryBot && (
              <div className="grok-field-section">
                <label className="grok-section-label">{t('运行节点', 'Host')}</label>
                <div className="grok-card-group">
                  <div className="grok-card-row no-active">
                    <span className="grok-row-label">{t('所属节点', 'Node')}</span>
                    <select
                      className="grok-inline-select"
                      value={editTargetHost}
                      onChange={e => { setEditTargetHost(e.target.value); editCwdDirtyRef.current = false; setEditCwd(''); }}
                    >
                      <option value="local">{t('本机', 'Local')}</option>
                      {remoteDevices.filter(device => device.deviceId !== localHost?.deviceId).map(device => (
                        <option key={device.deviceId} value={device.deviceId} disabled={!device.online}>
                          {device.displayName || device.deviceId}{device.platform ? ` · ${device.platform}` : ''}{device.online ? '' : ' · offline'}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {editMode === 'create' && !mustCreatePrimaryBot && (
              <div className="grok-field-section">
                <label className="grok-section-label">{t('主智能体设置', 'Primary Role')}</label>
                <div className="grok-card-group">
                  <div className="grok-card-row no-active">
                    <span className="grok-row-label">{t('创建后设为该节点的主智能体', 'Set as Primary Bot on this host')}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={editMakePrimary}
                      className={`grok-toggle-switch${editMakePrimary ? ' checked' : ''}`}
                      onClick={() => setEditMakePrimary(v => !v)}
                    >
                      <span className="grok-toggle-knob" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="grok-field-section">
              <label className="grok-section-label">{t('模型与能力', 'Model & Capabilities')}</label>
              <div className="grok-card-group">
                {editMode === 'create' ? <div className="grok-card-row no-active">{t('创建后在模型设置中选择，默认继承中心', 'Choose a model after creation; inherits from the center by default')}</div>
                  : !getOrCreateRemoteClient ? <div className="grok-card-row no-active">{t('请在独立助手中设置 Bot 模型', 'Set the bot model in the standalone assistant')}</div>
                  : <>
                    <button type="button" className="grok-card-row" onClick={() => openModelPickerSheet('bot-edit')} disabled={!remoteConnected || !remoteIdentity || !activeBot || (activeBot.hostKind === 'local' && !localHost?.deviceId)}>
                      <Cpu size={18} className="grok-row-icon"/><span className="grok-row-label">{t('Bot 模型设置', 'Bot model settings')}</span><ChevronRight size={18} className="grok-row-chevron"/>
                    </button>
                    <button type="button" className="grok-card-row" onClick={() => openModelPickerSheet('bot-edit', 'capabilities')} disabled={!remoteConnected || !remoteIdentity || !activeBot || (activeBot.hostKind === 'local' && !localHost?.deviceId)}>
                      <Puzzle size={18} className="grok-row-icon"/><span className="grok-row-label">{t('插件 / 技能 / MCP', 'Plugins / Skills / MCP')}</span><ChevronRight size={18} className="grok-row-chevron"/>
                    </button>
                  </>}
              </div>
            </div>

            {/* Voice Call Section (15847.jpg) */}
            <div className="grok-field-section">
              <label className="grok-section-label">{t('语音通话', 'Voice Call')}</label>
              <div className="grok-card-group">
                <div className="grok-card-row no-active">
                  <span className="grok-row-label">{t('语音', 'Voice')}</span>
                  <label className="grok-select-wrap">
                    <select value={editVoiceTone} onChange={e => setEditVoiceTone(e.target.value)}>
                      <option value="未设置">{t('未设置', 'Default')}</option>
                      <option value="清朗男声">{t('清朗男声', 'Clear Male')}</option>
                      <option value="温和女声">{t('温和女声', 'Warm Female')}</option>
                    </select>
                    <ChevronsUpDown size={15} />
                  </label>
                </div>
                <div className="grok-card-row no-active">
                  <span className="grok-row-label">{t('速度', 'Speed')}</span>
                  <label className="grok-select-wrap">
                    <select value={editVoiceSpeed} onChange={e => setEditVoiceSpeed(e.target.value)}>
                      <option value="0.75x">0.75x</option>
                      <option value="1x">1x</option>
                      <option value="1.25x">1.25x</option>
                      <option value="1.5x">1.5x</option>
                      <option value="2x">2x</option>
                    </select>
                    <ChevronsUpDown size={15} />
                  </label>
                </div>
                <div className="grok-card-row no-active">
                  <span className="grok-row-label">{t('语言', 'Language')}</span>
                  <label className="grok-select-wrap">
                    <select value={editVoiceLang} onChange={e => setEditVoiceLang(e.target.value)}>
                      <option value="自动">{t('自动', 'Auto')}</option>
                      <option value="中文">中文</option>
                      <option value="English">English</option>
                    </select>
                    <ChevronsUpDown size={15} />
                  </label>
                </div>
              </div>
            </div>

            <ErrorNotice error={action.error} onDismiss={() => action.setError('')} />
          </div>
        </main>
      )}

      {/* ==================== SCREEN 5: AVATAR PICKER VIEW (15848.jpg) ==================== */}
      {screen === 'bot-avatar' && (
        <main className="grok-subpage grok-page-enter">
          <header className="grok-subpage-topbar">
            <button
              type="button"
              className="grok-floating-circle-btn"
              aria-label={t('返回', 'Back')}
              onClick={() => setScreen(avatarReturnScreen)}
            >
              <ArrowLeft size={20} />
            </button>
            <h2 className="grok-subpage-header-title">{t('头像', 'Avatar')}</h2>
            <button
              type="button"
              className="grok-done-pill-btn"
              disabled={action.busy}
              onClick={() => void action.run(async () => {
                setEditAvatarPreset(draftAvatar);
                if (avatarReturnScreen === 'bot-profile' && activeBot) {
                  await saveAvatar(activeBot, draftAvatar);
                }
                setScreen(avatarReturnScreen);
              })}
            >
              {t('完成', 'Done')}
            </button>
          </header>

          <div className="grok-subpage-scroll">
            <ErrorNotice error={action.error} onDismiss={() => action.setError('')} />
            {/* Top Segmented Tabs (15848.jpg) */}
            <div className="grok-segmented-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={avatarTab === 'shape'}
                className={avatarTab === 'shape' ? 'active' : ''}
                onClick={() => setAvatarTab('shape')}
              >
                {t('形状', 'Shape')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={avatarTab === 'expression'}
                className={avatarTab === 'expression' ? 'active' : ''}
                onClick={() => setAvatarTab('expression')}
              >
                {t('表情', 'Expression')}
              </button>
            </div>

            {/* Large Centered Live Preview (15848.jpg) */}
            <div className="grok-avatar-big-preview">
              <GrokBotAvatar preset={draftAvatar} size={118} />
            </div>

            {/* White Rounded Card with Shapes/Expressions + 11 Color Swatches + Reset (15848.jpg) */}
            <section className="grok-avatar-card">
              {avatarTab === 'shape' ? (
                <div className="grok-shapes-grid">
                  {GROK_SHAPE_ORDER.map(item => {
                    const selected = draftAvatar.shape === item.shape;
                    const itemPreset: GrokAvatarPreset = {
                      ...draftAvatar,
                      id: `${item.shape}-${draftAvatar.color}`,
                      shape: item.shape,
                      rotation: item.rotation,
                    };
                    return (
                      <button
                        key={item.shape}
                        type="button"
                        className={`grok-shape-cell${selected ? ' selected' : ''}`}
                        onClick={() =>
                          setDraftAvatar(prev => ({
                            ...prev,
                            id: `${item.shape}-${prev.color}`,
                            shape: item.shape,
                            rotation: item.rotation,
                          }))
                        }
                        aria-label={t(item.labelZh, item.labelEn)}
                        aria-pressed={selected}
                      >
                        <GrokBotAvatar preset={itemPreset} size={46} />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grok-expressions-grid">
                  {GROK_EXPRESSION_LIST.map(expr => {
                    const selected = draftAvatar.expressionIndex === expr.index;
                    const exprPreset: GrokAvatarPreset = {
                      ...draftAvatar,
                      expressionIndex: expr.index,
                    };
                    return (
                      <button
                        key={expr.index}
                        type="button"
                        className={`grok-expression-cell${selected ? ' selected' : ''}`}
                        onClick={() =>
                          setDraftAvatar(prev => ({
                            ...prev,
                            expressionIndex: expr.index,
                          }))
                        }
                        aria-pressed={selected}
                      >
                        <GrokBotAvatar preset={exprPreset} size={52} />
                        <span>{t(expr.labelZh, expr.labelEn)}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* 11 Color Swatches (15848.jpg) */}
              <div className="grok-colors-grid">
                {GROK_COLOR_PALETTE.map(c => {
                  const selected = draftAvatar.color.toLowerCase() === c.hex.toLowerCase();
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`grok-color-swatch${selected ? ' selected' : ''}`}
                      onClick={() =>
                        setDraftAvatar(prev => ({
                          ...prev,
                          id: `${prev.shape}-${c.id}`,
                          color: c.hex,
                        }))
                      }
                      aria-label={t(c.labelZh, c.labelEn)}
                      aria-pressed={selected}
                    >
                      <span style={{ backgroundColor: c.hex }} />
                    </button>
                  );
                })}
              </div>

              <div className="grok-avatar-card-footer">
                <button
                  type="button"
                  className="grok-reset-link"
                  onClick={() => {
                    const def = activeBot
                      ? getDefaultBotAvatarPreset(botAvatarKey(activeBot), activeBot.role, activeBot.isPrimary)
                      : JARVIS_AVATAR_PRESET;
                    setDraftAvatar({ ...def });
                  }}
                >
                  {t('重置为默认', 'Reset to default')}
                </button>
              </div>
            </section>
          </div>
        </main>
      )}

      {/* ==================== SCREEN 6: SOUL DOCUMENT EDITOR (SOUL.md) ==================== */}
      {screen === 'bot-soul' && (
        <main className="grok-subpage grok-page-enter">
          <header className="grok-subpage-topbar">
            <button
              type="button"
              className="grok-floating-circle-btn"
              aria-label={t('返回', 'Back')}
              onClick={() => setScreen(subPageReturnScreen)}
            >
              <ArrowLeft size={20} />
            </button>
            <h2 className="grok-subpage-header-title">{t('灵魂文档', 'Soul Document')}</h2>
            <button
              type="button"
              className="grok-done-pill-btn"
              disabled={action.busy || soulBytes(soulDraft) > SOUL_MAX_BYTES}
              onClick={() => void handleSaveSoul()}
            >
              {action.busy ? t('保存中', 'Saving') : t('保存', 'Save')}
            </button>
          </header>

          <div className="grok-subpage-scroll">
            <div className="soul-snippet-bar" style={{ margin: '2px 2px 4px' }}>
              {SOUL_SNIPPETS.map(item => (
                <button
                  key={item.zh}
                  type="button"
                  className="snippet-chip"
                  onClick={() => {
                    setSoulDraft(prev => (prev ? prev.trimEnd() + '\n' : '') + item.text.trimStart());
                    setSoulDirty(true);
                  }}
                >
                  {t(item.zh, item.en)}
                </button>
              ))}
              {soulDraft.length > 0 && (
                <button
                  type="button"
                  className="snippet-chip danger"
                  onClick={() => {
                    setSoulDraft('');
                    setSoulDirty(true);
                  }}
                >
                  {t('清空', 'Clear')}
                </button>
              )}
            </div>

            <section className="grok-card-group" style={{ padding: 14 }}>
              <textarea
                className="grok-soul-textarea"
                rows={14}
                spellCheck={false}
                value={soulDraft}
                onChange={e => {
                  setSoulDraft(e.target.value);
                  setSoulDirty(true);
                }}
                placeholder={t(
                  '# 核心人设\n在这里编写 Bot 的身份、说话语气、专业领域和行为边界…',
                  '# Core Persona\nWrite the Bot identity, tone, expertise, and boundaries here…',
                )}
              />
              <div className="soul-byte-progress" style={{ marginTop: 10 }}>
                <div className="soul-byte-bar">
                  <div
                    className={`soul-byte-fill ${soulBytes(soulDraft) > SOUL_MAX_BYTES ? 'over' : ''}`}
                    style={{ width: `${Math.min(100, Math.round((soulBytes(soulDraft) / SOUL_MAX_BYTES) * 100))}%` }}
                  />
                </div>
                <div className="soul-byte-meta">
                  <span>
                    {botSoul?.revision ? `Rev: ${botSoul.revision.slice(0, 10)}` : t('草稿', 'Draft')}
                  </span>
                  <span>
                    {`${soulBytes(soulDraft).toLocaleString()} / ${SOUL_MAX_BYTES.toLocaleString()} B`}
                  </span>
                </div>
              </div>
            </section>
            <p className="grok-card-footnote">
              {t(
                '定义该 Bot 的人设、语气风格与行动准则，每次对话会自动生效。',
                'Defines the persona, tone, and principles automatically applied in every conversation.',
              )}
            </p>

            {soulDirty && activeBot && (
              <section className="grok-card-group">
                <button
                  type="button"
                  className="grok-card-row"
                  onClick={() => void loadBotSoul(activeBot)}
                >
                  <RefreshCw size={18} className="grok-row-icon" />
                  <span className="grok-row-label">{t('放弃未保存修改', 'Discard unsaved changes')}</span>
                </button>
              </section>
            )}

            <ErrorNotice error={action.error} onDismiss={() => action.setError('')} />
          </div>
        </main>
      )}

      {/* ==================== SCREEN 7B: BOT SCHEDULED TASKS ==================== */}
      {screen === 'bot-schedules' && activeBot && (
        <main className="grok-subpage grok-page-enter">
          <header className="grok-subpage-topbar">
            <button
              type="button"
              className="grok-floating-circle-btn"
              aria-label={t('返回', 'Back')}
              onClick={() => {
                if (scheduleEditing) {
                  setScheduleEditing(null);
                } else {
                  setScreen(subPageReturnScreen);
                }
              }}
            >
              <ArrowLeft size={20} />
            </button>
            <h2 className="grok-subpage-header-title">
              {scheduleEditing
                ? scheduleDraft.id
                  ? t('编辑定时任务', 'Edit Schedule')
                  : t('新建定时任务', 'New Schedule')
                : t(
                    `定时任务 · ${botMetaMap[activeBot.key]?.customName || activeBot.role}`,
                    `Schedules · ${botMetaMap[activeBot.key]?.customName || activeBot.role}`,
                  )}
            </h2>
            {scheduleEditing ? (
              <button
                type="button"
                className="grok-done-pill-btn"
                disabled={action.busy || !scheduleDraft.prompt.trim()}
                onClick={() => void handleSaveSchedule()}
              >
                {action.busy ? t('保存中', 'Saving') : t('保存', 'Save')}
              </button>
            ) : (
              <button
                type="button"
                className="grok-done-pill-btn"
                onClick={() => openScheduleCreate()}
              >
                <Plus size={16} style={{ marginRight: 4 }} />
                {t('新建', 'New')}
              </button>
            )}
          </header>

          {!scheduleEditing ? (
            <div className="grok-subpage-scroll">
              {/* Filter Tabs */}
              <div className="grok-schedule-filter-bar" role="tablist">
                {(
                  [
                    {
                      id: 'all' as const,
                      label: t(`全部 (${botScheduleState.tasks.length})`, `All (${botScheduleState.tasks.length})`),
                    },
                    {
                      id: 'enabled' as const,
                      label: t(
                        `已开启 (${botScheduleState.tasks.filter(x => x.enabled !== false).length})`,
                        `Active (${botScheduleState.tasks.filter(x => x.enabled !== false).length})`,
                      ),
                    },
                    {
                      id: 'paused' as const,
                      label: t(
                        `已暂停 (${botScheduleState.tasks.filter(x => x.enabled === false).length})`,
                        `Paused (${botScheduleState.tasks.filter(x => x.enabled === false).length})`,
                      ),
                    },
                  ]
                ).map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={scheduleFilter === tab.id}
                    className={`grok-schedule-filter-tab${scheduleFilter === tab.id ? ' active' : ''}`}
                    onClick={() => setScheduleFilter(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {!botScheduleState.exactAlarmGranted && (
                <section className="grok-card-group grok-schedule-permission-banner">
                  <div className="grok-schedule-permission-text">
                    <strong>{t('精确闹钟权限未开启', 'Exact Alarm Permission Needed')}</strong>
                    <span>
                      {t(
                        '开启后可保证定时任务在锁屏与后台状态下准点唤醒该 Bot 执行。',
                        'Grant exact alarm permission for punctual background execution.',
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="grok-done-pill-btn"
                    onClick={() => void handleRequestExactAlarm()}
                  >
                    {t('去授权', 'Grant')}
                  </button>
                </section>
              )}

              {(() => {
                const filteredTasks = botScheduleState.tasks.filter(task => {
                  if (scheduleFilter === 'enabled') return task.enabled !== false;
                  if (scheduleFilter === 'paused') return task.enabled === false;
                  return true;
                });

                const botDisplayName = botMetaMap[activeBot.key]?.customName || activeBot.role;

                if (filteredTasks.length === 0) {
                  return (
                    <section className="grok-card-group grok-schedule-empty">
                      <Clock size={32} className="grok-row-icon" />
                      <h4>
                        {scheduleFilter === 'all'
                          ? t(`还没有为「${botDisplayName}」设置定时任务`, `No schedules for ${botDisplayName}`)
                          : scheduleFilter === 'enabled'
                            ? t('暂无已开启的定时任务', 'No active schedules')
                            : t('暂无已暂停的定时任务', 'No paused schedules')}
                      </h4>
                      <p>
                        {t(
                          '定时任务到点后会自动唤醒该 Bot 执行指令（例如：每日早报汇总、待办提醒、定时巡检）。',
                          'Scheduled tasks wake this Bot at the specified time to run your prompt automatically.',
                        )}
                      </p>
                      <button
                        type="button"
                        className="grok-done-pill-btn"
                        style={{ marginTop: 8 }}
                        onClick={() => openScheduleCreate()}
                      >
                        <Plus size={16} style={{ marginRight: 4 }} />
                        {t('新建定时任务', 'Create Schedule')}
                      </button>
                    </section>
                  );
                }

                return (
                  <div className="grok-schedule-list">
                    {filteredTasks.map(task => {
                      const isEnabled = task.enabled !== false;
                      const accentColor = resolveBotAvatarPreset(
                        botAvatarKey(activeBot),
                        activeBot.role,
                        activeBot.isPrimary,
                      ).color;
                      return (
                        <section
                          key={task.id}
                          className={`grok-card-group grok-schedule-card${isEnabled ? '' : ' paused'}`}
                        >
                          <div className="grok-schedule-card-top">
                            <div
                              className="grok-schedule-card-time-wrap"
                              role="button"
                              tabIndex={0}
                              onClick={() => openScheduleEdit(task)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  openScheduleEdit(task);
                                }
                              }}
                            >
                              <span className="grok-schedule-time">{task.time || '09:00'}</span>
                              <div className="grok-schedule-badges">
                                <span className="grok-schedule-badge">
                                  {formatScheduleRepeatLabel(task, t)}
                                </span>
                                <span className={`grok-schedule-badge ${task.alarmMode === 'alarmClock' ? 'alarm' : 'silent'}`}>
                                  {task.alarmMode === 'alarmClock'
                                    ? t('🔔 强提醒', '🔔 Alarm')
                                    : t('⚡ 后台执行', '⚡ Silent')}
                                </span>
                              </div>
                            </div>

                            <button
                              type="button"
                              role="switch"
                              aria-checked={isEnabled}
                              className={`grok-toggle-switch${isEnabled ? ' checked' : ''}`}
                              style={isEnabled ? { backgroundColor: accentColor } : undefined}
                              onClick={() => void handleToggleSchedule(task, !isEnabled)}
                            >
                              <span className="grok-toggle-knob" />
                            </button>
                          </div>

                          <div
                            className="grok-schedule-card-body"
                            role="button"
                            tabIndex={0}
                            onClick={() => openScheduleEdit(task)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                openScheduleEdit(task);
                              }
                            }}
                          >
                            <div className="grok-schedule-title">
                              {task.title || t('未命名定时任务', 'Untitled Task')}
                            </div>
                            <div className="grok-schedule-prompt">
                              {task.prompt || t('点击编辑任务指令…', 'Tap to edit prompt…')}
                            </div>
                          </div>

                          <div className="grok-schedule-card-footer">
                            <span className="grok-schedule-next">
                              {isEnabled
                                ? `${t('下次执行：', 'Next: ')}${formatScheduleNextRun(
                                    task.nextRunAt,
                                    botScheduleState.timeZone,
                                    t,
                                  )}`
                                : t('已暂停', 'Paused')}
                            </span>
                            <div className="grok-schedule-actions">
                              <button
                                type="button"
                                className="grok-schedule-icon-btn"
                                aria-label={t('编辑', 'Edit')}
                                onClick={() => openScheduleEdit(task)}
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                type="button"
                                className="grok-schedule-icon-btn danger"
                                aria-label={t('删除', 'Delete')}
                                onClick={() => void handleDeleteSchedule(task)}
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </div>
                        </section>
                      );
                    })}
                  </div>
                );
              })()}

              <ErrorNotice
                error={action.error || botScheduleState.schedulingError}
                onDismiss={action.error ? () => action.setError('') : undefined}
              />
            </div>
          ) : (
            <div className="grok-subpage-scroll">
              {/* Time & Repeat Section */}
              <div className="grok-field-section">
                <label className="grok-section-label">{t('执行时间与周期', 'Time & Recurrence')}</label>
                <section className="grok-card-group">
                  <label className="grok-card-row grok-input-row">
                    <span className="grok-input-label">{t('触发时间', 'Time')}</span>
                    <input
                      type="time"
                      className="grok-inline-input grok-time-input"
                      value={scheduleDraft.time}
                      onChange={e => setScheduleDraft(prev => ({ ...prev, time: e.target.value || '09:00' }))}
                    />
                  </label>

                  <div className="grok-card-row no-active">
                    <span className="grok-row-label">{t('重复周期', 'Repeat')}</span>
                    <label className="grok-select-wrap">
                      <select
                        value={
                          scheduleDraft.repeat === 'weekly' && !scheduleCustomWeekdays
                            ? scheduleDraft.weekdays.length === 5 &&
                              [1, 2, 3, 4, 5].every(d => scheduleDraft.weekdays.includes(d))
                              ? 'weekdays-mon-fri'
                              : scheduleDraft.weekdays.length === 2 &&
                                  [6, 7].every(d => scheduleDraft.weekdays.includes(d))
                                ? 'weekends-sat-sun'
                                : 'weekly'
                            : scheduleDraft.repeat
                        }
                        onChange={e => {
                          const val = e.target.value;
                          if (val === 'weekdays-mon-fri') {
                            setScheduleCustomWeekdays(false);
                            setScheduleDraft(prev => ({
                              ...prev,
                              repeat: 'weekly',
                              weekdays: [1, 2, 3, 4, 5],
                              deleteAfterRun: false,
                            }));
                          } else if (val === 'weekends-sat-sun') {
                            setScheduleCustomWeekdays(false);
                            setScheduleDraft(prev => ({
                              ...prev,
                              repeat: 'weekly',
                              weekdays: [6, 7],
                              deleteAfterRun: false,
                            }));
                          } else if (val === 'weekly') {
                            setScheduleCustomWeekdays(true);
                            setScheduleDraft(prev => ({
                              ...prev,
                              repeat: 'weekly',
                              weekdays: prev.weekdays.length > 0 ? prev.weekdays : [1],
                              deleteAfterRun: false,
                            }));
                          } else {
                            setScheduleCustomWeekdays(false);
                            const mode = val as BotScheduleDraft['repeat'];
                            setScheduleDraft(prev => ({
                              ...prev,
                              repeat: mode,
                              deleteAfterRun: mode === 'once' ? prev.deleteAfterRun : false,
                            }));
                          }
                        }}
                      >
                        <option value="daily">{t('每天', 'Daily')}</option>
                        <option value="statutoryWorkday">{t('法定工作日（智能跳过节假日）', 'Statutory Workdays')}</option>
                        <option value="statutoryHoliday">{t('法定节假日', 'Statutory Holidays')}</option>
                        <option value="weekdays-mon-fri">{t('每周一至周五', 'Mon–Fri')}</option>
                        <option value="weekends-sat-sun">{t('每个周末（周六、周日）', 'Weekends')}</option>
                        <option value="weekly">{t('自定义每周几…', 'Custom Weekdays…')}</option>
                        <option value="monthly">{t('每月固定日期', 'Monthly')}</option>
                        <option value="once">{t('单次执行（最近一次到点）', 'One-time (Next occurrence)')}</option>
                      </select>
                      <ChevronsUpDown size={15} />
                    </label>
                  </div>

                  {scheduleDraft.repeat === 'weekly' && scheduleCustomWeekdays && (
                    <div className="grok-card-row grok-weekday-row">
                      {[
                        { day: 1, zh: '一', en: 'M' },
                        { day: 2, zh: '二', en: 'T' },
                        { day: 3, zh: '三', en: 'W' },
                        { day: 4, zh: '四', en: 'T' },
                        { day: 5, zh: '五', en: 'F' },
                        { day: 6, zh: '六', en: 'S' },
                        { day: 7, zh: '日', en: 'S' },
                      ].map(item => {
                        const active = scheduleDraft.weekdays.includes(item.day);
                        return (
                          <button
                            key={item.day}
                            type="button"
                            className={`grok-weekday-chip${active ? ' active' : ''}`}
                            onClick={() => {
                              setScheduleDraft(prev => {
                                const exists = prev.weekdays.includes(item.day);
                                const next = exists
                                  ? prev.weekdays.filter(d => d !== item.day)
                                  : [...prev.weekdays, item.day].sort((a, b) => a - b);
                                return { ...prev, weekdays: next.length > 0 ? next : [item.day] };
                              });
                            }}
                          >
                            {t(item.zh, item.en)}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {scheduleDraft.repeat === 'monthly' && (
                    <label className="grok-card-row grok-input-row">
                      <span className="grok-input-label">{t('每月几号', 'Day of Month')}</span>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        className="grok-inline-input"
                        value={scheduleDraft.monthDay}
                        onChange={e => {
                          const d = Math.max(1, Math.min(31, Number(e.target.value) || 1));
                          setScheduleDraft(prev => ({ ...prev, monthDay: d }));
                        }}
                      />
                    </label>
                  )}
                </section>
              </div>

              {/* Task Content Section */}
              <div className="grok-field-section">
                <label className="grok-section-label">{t('任务标题与执行指令', 'Task Title & Prompt')}</label>
                <section className="grok-card-group">
                  <label className="grok-card-row grok-input-row">
                    <span className="grok-input-label">{t('任务名称', 'Title')}</span>
                    <input
                      className="grok-inline-input"
                      value={scheduleDraft.title}
                      onChange={e => setScheduleDraft(prev => ({ ...prev, title: e.target.value }))}
                      placeholder={t('例如：每日科技早报、下班打卡提醒', 'e.g. Daily briefing, Standup reminder')}
                    />
                  </label>
                  <div className="grok-card-textarea-wrap">
                    <textarea
                      rows={4}
                      value={scheduleDraft.prompt}
                      onChange={e => setScheduleDraft(prev => ({ ...prev, prompt: e.target.value }))}
                      placeholder={t(
                        '到点后发送给该 Bot 执行的指令内容，例如：汇总今天的日程与待办事项，并生成简短提醒。',
                        'Prompt sent to this Bot when triggered, e.g. Summarize my agenda and key tasks for today.',
                      )}
                    />
                  </div>
                </section>
              </div>

              {/* Reminder & Lifecycle Section */}
              <div className="grok-field-section">
                <label className="grok-section-label">{t('提醒方式与状态', 'Notification & Status')}</label>
                <section className="grok-card-group">
                  <div className="grok-card-row no-active">
                    <span className="grok-row-label">{t('强提醒模式（响铃与弹窗）', 'Alarm Mode (Ring & Alert)')}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={scheduleDraft.alarmMode === 'alarmClock'}
                      className={`grok-toggle-switch${scheduleDraft.alarmMode === 'alarmClock' ? ' checked' : ''}`}
                      onClick={() =>
                        setScheduleDraft(prev => ({
                          ...prev,
                          alarmMode: prev.alarmMode === 'alarmClock' ? 'exact' : 'alarmClock',
                        }))
                      }
                    >
                      <span className="grok-toggle-knob" />
                    </button>
                  </div>

                  {scheduleDraft.alarmMode === 'alarmClock' && (
                    <div className="grok-card-row no-active">
                      <span className="grok-row-label">{t('震动提醒', 'Vibrate')}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={scheduleDraft.vibrate}
                        className={`grok-toggle-switch${scheduleDraft.vibrate ? ' checked' : ''}`}
                        onClick={() => setScheduleDraft(prev => ({ ...prev, vibrate: !prev.vibrate }))}
                      >
                        <span className="grok-toggle-knob" />
                      </button>
                    </div>
                  )}

                  {scheduleDraft.repeat === 'once' && (
                    <div className="grok-card-row no-active">
                      <span className="grok-row-label">{t('触发后自动删除任务', 'Delete After Run')}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={scheduleDraft.deleteAfterRun}
                        className={`grok-toggle-switch${scheduleDraft.deleteAfterRun ? ' checked' : ''}`}
                        onClick={() => setScheduleDraft(prev => ({ ...prev, deleteAfterRun: !prev.deleteAfterRun }))}
                      >
                        <span className="grok-toggle-knob" />
                      </button>
                    </div>
                  )}
                </section>
              </div>

              {scheduleDraft.id && (
                <section className="grok-card-group">
                  <button
                    type="button"
                    className="grok-card-row danger-text"
                    onClick={() => {
                      const existing = botScheduleState.tasks.find(x => x.id === scheduleDraft.id);
                      if (existing) {
                        void handleDeleteSchedule(existing);
                        setScheduleEditing(null);
                      }
                    }}
                  >
                    <Trash2 size={18} />
                    <span className="grok-row-label">{t('删除该定时任务', 'Delete Schedule')}</span>
                  </button>
                </section>
              )}

              <ErrorNotice
                error={action.error || botScheduleState.schedulingError}
                onDismiss={action.error ? () => action.setError('') : undefined}
              />
            </div>
          )}
        </main>
      )}

      {(screen === 'conversation' || screen === 'dm' || screen === 'pending') && (
        <main className="grok-subpage grok-page-enter">
          {screen === 'pending' && (
            <header className="grok-subpage-topbar">
              <button
                type="button"
                className="grok-floating-circle-btn"
                onClick={() => setScreen('hub')}
                aria-label={t('返回', 'Back')}
              >
                <ArrowLeft size={20} />
              </button>
              <h2 className="grok-subpage-header-title">{t('待发送', 'Pending')}</h2>
              <span style={{ width: 44 }} />
            </header>
          )}
          {/* conversation/dm 页面头由 Scopes 会话头承担：宿主不再叠一层标题栏，
              容器占满高、消息区独立滚动、底部输入不随页面滚动离开。 */}
          <div className={screen === 'pending' ? 'grok-subpage-scroll' : 'grok-subpage-fill'}>
            {screen === 'conversation' ? (
              scopeConversationTarget ? (
                // 打开时捕获的 api 可能带旧 targetOnline/失效代际；按稳定 profile/kind/device
                // 重新解析当前来源 api，离线/上线切换即生效。
                (() => {
                  const tid = scopeConversationTarget.identity;
                  const liveApi = scopeConversationSources.find(s =>
                    s.identity?.profileId === tid.profileId &&
                    s.identity?.kind === tid.kind &&
                    s.identity?.targetDeviceId === tid.targetDeviceId,
                  )?.api ?? scopeConversationTarget.api;
                  return (
                <div className="grok-scopes-mobile-container">
                  <Scopes
                    key={`room-${scopeConversationTarget.key}`}
                    api={liveApi}
                    pageActive={active}
                    // 群聊开放用户写入口：写端由 resolver 路由（成员→authority、发送→成员 Host）；
                    // 未接入写端显示待连接而非只读。DM 路径不受影响仍只读。
                    readOnly={false}
                    resolveRoomApi={resolveRoomApi}
                    memberCandidates={roomMemberCandidates}
                    detailOnly
                    scopeKind="room"
                    initialScopeId={scopeConversationTarget.scope.scope.scopeId}
                    knownBots={knownBots}
                    settingsOpen={roomSettingsOpen}
                    onSettingsOpenChange={setRoomSettingsOpen}
                    onDeleted={() => {
                      const deletedScopeId = scopeConversationTarget.scope.scope.scopeId;
                      unconfirmedRoomDeletesRef.current.delete(deletedScopeId);
                      chatPins.removePin(roomPinKey(deletedScopeId));
                      setRoomSettingsOpen(false);
                      setScopeConversationTarget(null);
                      setScreen('hub');
                      refreshRoomConversationsRef.current();
                    }}
                    onOpenLink={openScopeLink}
                    onBack={() => {
                      setRoomSettingsOpen(false);
                      setScreen(scopeReturnScreen);
                    }}
                    onOpenBot={handleOpenBot}
                  />
                </div>
                  );
                })()
              ) : null
            ) : screen === 'dm' ? (
              dmTarget ? (
                (() => {
                  const bot = dmTarget.bot;
                  const dmSource = scopeConversationSources.find(source => {
                    if (bot.hostKind === 'local') return source.api === localScopeApi;
                    return source.identity?.targetDeviceId === bot.hostId;
                  });
                  if (!dmSource) {
                    return (
                      <section className="grok-card-group grok-schedule-empty" style={{ marginTop: 12 }}>
                        <Globe size={28} className="grok-row-icon" />
                        <h4>{bot.hostKind === 'remote' ? t('远端节点未连接', 'Remote node not connected') : t('本机 Host 未就绪', 'Local host not ready')}</h4>
                        <p>{bot.hostKind === 'remote'
                          ? t('连接远端节点后可查看该 Bot 的私聊。', 'Connect to the remote node to view this Bot\'s private chats.')
                          : t('Host 启动后即可查看该 Bot 的私聊记录。', 'Once the host is running you can view this Bot\'s private chats.')}</p>
                      </section>
                    );
                  }
                  const participant: MessageMember = { deviceId: bot.deviceId, botId: bot.botId };
                  return (
                    <div className="grok-scopes-mobile-container">
                      <Scopes
                        key={`dm-${dmSource.identity?.profileId ?? 'local'}|${dmSource.identity?.generation ?? 0}|${participant.deviceId}|${participant.botId}`}
                        api={dmSource.api}
                        pageActive={active}
                        readOnly
                        scopeKind="dm"
                        participant={participant}
                        participantName={bot.role}
                        selectedScopeId={dmSelectedScopeId}
                        onSelectScope={setDmSelectedScopeId}
                        // DM 列表头返回其来源页；详情返回由受控 selectedScopeId 清空（见 handleStepBack）。
                        onBack={dmSelectedScopeId ? undefined : () => setScreen(dmTarget.returnScreen)}
                        knownBots={knownBots}
                        onOpenLink={openScopeLink}
                        onOpenBot={handleOpenBot}
                      />
                    </div>
                  );
                })()
              ) : null
            ) : remoteClientRef.current && remoteIdentity ? (
              <>
                <div className="grok-field-section">
                  <label className="grok-section-label">{t('当前操作节点', 'Target Node')}</label>
                  <section className="grok-card-group">
                    <div className="grok-card-row no-active">
                      <Server size={18} className="grok-row-icon" />
                      <span className="grok-row-label">{t('目标设备', 'Target device')}</span>
                      <label className="grok-select-wrap">
                        <select
                          value={remoteIdentity.targetDeviceId}
                          onChange={e => {
                            const api = remoteClientRef.current!.api;
                            api.setIdentity({
                              profileId: remoteIdentity.profileId,
                              kind: remoteIdentity.kind,
                              targetDeviceId: e.target.value,
                            });
                          }}
                        >
                          <option value="">{t('请选择设备', 'Select device')}</option>
                          {remoteDevices.map(device => (
                            <option key={device.deviceId} value={device.deviceId}>
                              {device.displayName || device.deviceId}
                            </option>
                          ))}
                        </select>
                        <ChevronsUpDown size={15} />
                      </label>
                    </div>
                  </section>
                </div>

                {!remoteIdentity.targetDeviceId ? (
                  <section className="grok-card-group grok-schedule-empty">
                    <Server size={28} className="grok-row-icon" />
                    <h4>{t('请先选择目标节点设备', 'Select a Target Device')}</h4>
                    <p>
                      {t(
                        '在上方下拉菜单中选择已连接的节点设备，即可查看该节点上的待发送队列。',
                        'Choose a connected device above to view its pending queue.',
                      )}
                    </p>
                  </section>
                ) : (
                  <div className="grok-pending-mobile-container">
                    <PendingPanel
                      key={`${remoteIdentity.profileId}|${remoteIdentity.kind}|${remoteIdentity.targetDeviceId}`}
                      api={remoteClientRef.current.api}
                      identity={remoteIdentity}
                      transportConnected={remoteConnected}
                    />
                  </div>
                )}
              </>
            ) : (
              <section className="grok-card-group grok-schedule-empty" style={{ marginTop: 12 }}>
                <Globe size={28} className="grok-row-icon" />
                <h4>{t('尚未连接中心或远程节点', 'Not Connected to Center or Remote Node')}</h4>
                <p>
                  {t(
                    '请先在设置中配置并连接中心服务或远程节点，连接成功后即可使用群聊与待发送对账。',
                    'Configure and connect to Center or a remote host in Settings first.',
                  )}
                </p>
                <button
                  type="button"
                  className="grok-done-pill-btn"
                  style={{ marginTop: 8 }}
                  onClick={() => setScreen('settings')}
                >
                  {t('前往设置连接', 'Go to Settings')}
                </button>
              </section>
            )}
          </div>
        </main>
      )}

      {/* ==================== SCREEN 8: SETTINGS VIEW ==================== */}
      {screen === 'settings' && (
        <HubSettingsView
          onBack={() => setScreen('hub')}
          ensureRemoteApi={ensureRemoteApi}
          remoteProfiles={remoteProfiles}
          remoteIdentity={remoteIdentity}
          remoteConnected={remoteConnected}
          remoteDevices={remoteDevices}
          setRemoteDevices={setRemoteDevices}
          onRemoteUpdated={() => {
            void syncRemoteBots();
          }}
          archivedCount={archivedBots.length}
          onOpenArchivedBots={() => setScreen('archived-bots')}
          onOpenModelSheet={() => void openCenterManagement()}
          onOpenSystemSettings={onOpenSystemSettings}
        />
      )}

      {/* ==================== SCREEN 8B: ARCHIVED BOTS LIST VIEW ==================== */}
      {screen === 'archived-bots' && (
        <main className="grok-subpage grok-page-enter" aria-label={t('已归档智能体', 'Archived Bots')}>
          <header className="grok-subpage-topbar">
            <button
              type="button"
              className="grok-floating-circle-btn"
              onClick={() => setScreen('settings')}
              aria-label={t('返回设置', 'Back to settings')}
            >
              <ArrowLeft size={20} />
            </button>
            <h2 className="grok-subpage-header-title">
              {t(`已归档智能体 (${archivedBots.length})`, `Archived Bots (${archivedBots.length})`)}
            </h2>
            <span style={{ width: 44 }} />
          </header>

          <div className="grok-subpage-scroll">
            <p className="grok-card-footnote" style={{ marginTop: 2 }}>
              {t(
                '已归档的智能体保留 14 天，到期后自动清理。点击条目可查看只读历史对话，也可随时恢复或永久删除。',
                'Archived bots are retained for 14 days before auto-deletion. Tap a bot to view read-only history, restore, or permanently delete.',
              )}
            </p>
            <ErrorNotice error={action.error} onDismiss={() => action.setError('')} />

            {archivedBots.length === 0 ? (
              <section className="grok-card-group grok-schedule-empty">
                <Archive size={28} className="grok-row-icon" />
                <h4>{t('暂无已归档智能体', 'No Archived Bots')}</h4>
                <p>
                  {t(
                    '归档后的智能体会收纳在此处并保留 14 天，不会继续显示在主页列表中。',
                    'Archived bots are kept here for 14 days and hidden from the main Hub list.',
                  )}
                </p>
              </section>
            ) : (
              <section className="grok-card-group grok-archived-list-group">
                {archivedBots.map(item => {
                  const daysLeft = formatArchivedRemainingDays(item.archivedAt);
                  const preset = resolveBotAvatarPreset(botAvatarKey(item), item.role, false);
                  return (
                    <HubArchivedRow
                      key={item.key}
                      onOpen={() => openBotChat(item, 'archived-bots')}
                      onOpenMenu={(position) => setHubContextMenu({ ...position, bot: item })}
                    >
                      <div className="hub-bot-avatar-col">
                        <GrokBotAvatar preset={preset} size={46} />
                      </div>
                      <div className="hub-bot-content-col">
                        <div className="hub-bot-title-line">
                          <span className="hub-bot-title">{item.role}</span>
                          {hasRemoteConfigured && (
                            <span className={`hub-bot-host-badge ${item.hostKind}${item.online === false ? ' is-offline' : ''}`}>
                              <PlatformLogoIcon platform={item.platform} size={11} />
                              <span className="hub-bot-host-text">{item.hostLabel}</span>
                            </span>
                          )}
                          <span className="hub-bot-time grok-archived-ttl-pill">
                            {t(`剩余 ${daysLeft} 天（共 14 天）`, `${daysLeft}d / 14d left`)}
                          </span>
                        </div>
                        <div className="hub-bot-subtitle-line" style={{ gap: 8 }}>
                          <span className="hub-bot-snippet">
                            {item.lastPreview || item.description || t('点击查看只读历史 · 14 天后自动清理', 'Tap for read-only history · 14d auto-delete')}
                          </span>
                          <button
                            type="button"
                            className="hub-outline-btn"
                            style={{ padding: '3px 10px', fontSize: '0.76rem' }}
                            disabled={action.busy}
                            onClick={e => {
                              e.stopPropagation();
                              void handleUnarchiveBot(item);
                            }}
                          >
                            {t('恢复', 'Restore')}
                          </button>
                          <button
                            type="button"
                            className="hub-outline-btn danger"
                            style={{ padding: '3px 10px', fontSize: '0.76rem' }}
                            disabled={action.busy}
                            onClick={e => {
                              e.stopPropagation();
                              requestDeleteBot(item);
                            }}
                          >
                            {t('永久删除智能体', 'Permanently Delete')}
                          </button>
                        </div>
                      </div>
                    </HubArchivedRow>
                  );
                })}
              </section>
            )}
          </div>
        </main>
      )}

      {modelTarget && activeBot?.key === modelTarget.botKey && activeBot.botId === modelTarget.botId &&
        activeCenter === modelTarget.center && remoteConnected && remoteIdentity?.generation === modelTarget.identity.generation &&
        (activeBot.hostKind === 'local' ? localHost?.deviceId : activeBot.hostId) === modelTarget.identity.targetDeviceId &&
        (screen === 'bot-profile' || (screen === 'bot-edit' && editMode === 'edit')) &&
        <BotModelSheet key={`${modelTarget.center}|${modelTarget.botKey}|${modelTarget.identity.generation}|${modelTarget.tab}`} api={modelTarget.api} identity={modelTarget.identity} botId={modelTarget.botId} initialTab={modelTarget.tab} onClose={() => setModelTarget(null)}/>}

      {/* ==================== LEFT HIDDEN SIDEBAR DRAWER (Persistent for smooth slide animation) ==================== */}
      <div
        className={`grok-drawer-layer left${leftDrawerOpen ? ' open' : ''}`}
        aria-hidden={!leftDrawerOpen}
        onClick={() => setLeftDrawerOpen(false)}
      >
        <aside
          className="grok-left-drawer"
          role="dialog"
          aria-label={t('左侧边栏', 'Left sidebar')}
          onClick={e => e.stopPropagation()}
        >
          <header className="hub-left-drawer-header">
            <div className="hub-left-drawer-brand">
              <GrokBotAvatar preset={primaryPreset} isPrimary size={34} />
              <div className="hub-left-drawer-brand-text">
                <strong>Bot Hub</strong>
                <span>
                  {centerConn.connecting
                    ? t('正在连接中心…', 'Connecting…')
                    : centerConn.ready
                      ? t('中心已连接', 'Center Online')
                      : centerConn.saved ? t('连接已断开', 'Disconnected') : t('本机模式', 'Local Mode')}
                </span>
              </div>
            </div>
          </header>

          <nav className="hub-left-drawer-nav" aria-label={t('导航菜单', 'Navigation')}>
            <button
              type="button"
              className="hub-left-nav-btn"
              onClick={() => {
                setLeftDrawerOpen(false);
                setScreen('pending');
              }}
            >
              <Clock size={19} />
              <span>{t('待发送', 'Pending')}</span>
              <ChevronRight size={16} className="hub-left-nav-chevron" />
            </button>
          </nav>

          <div className="hub-left-drawer-spacer" />

          <footer className="hub-left-drawer-footer">
            <button
              type="button"
              className="hub-left-settings-btn"
              onClick={() => {
                setLeftDrawerOpen(false);
                setScreen('settings');
              }}
            >
              <Settings size={20} />
              <span>{t('设置', 'Settings')}</span>
            </button>
          </footer>
        </aside>
      </div>

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
                        onSelect: () => openBotProfile(bot, screen),
                      },
                      {
                        key: 'bot-dm',
                        label: t('查看 Bot 私聊', 'View Bot DMs'),
                        icon: <MessageSquare size={16} />,
                        onSelect: () => openBotDmList(bot),
                      },
                      {
                        key: 'bot-unarchive',
                        label: t('恢复智能体', 'Restore Bot'),
                        icon: <RotateCcw size={16} />,
                        onSelect: () => void handleUnarchiveBot(bot),
                      },
                      ...(!bot.isPrimary
                        ? [
                            {
                              key: 'bot-delete',
                              label: t('永久删除智能体', 'Permanently Delete Bot'),
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
                      onSelect: () => openBotProfile(bot, screen),
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
                            label: t('归档智能体', 'Archive Bot'),
                            icon: <Archive size={16} />,
                            onSelect: () => requestArchiveBot(bot),
                          },
                          {
                            key: 'bot-delete',
                            label: t('永久删除智能体', 'Permanently Delete Bot'),
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

      {/* Bot 归档 / 永久删除 二次确认弹窗（React 原生同风格卡片，不使用 window.confirm） */}
      {botConfirmModal && (
        <div
          className="grok-confirm-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={
            botConfirmModal.kind === 'archive'
              ? t('归档智能体', 'Archive Bot')
              : t('永久删除智能体', 'Permanently Delete Bot')
          }
          onClick={() => {
            if (!action.busy) setBotConfirmModal(null);
          }}
        >
          <div className="grok-confirm-dialog" onClick={e => e.stopPropagation()}>
            <h3 className="grok-confirm-title">
              {botConfirmModal.kind === 'archive'
                ? t('归档智能体', 'Archive Bot')
                : t('永久删除智能体', 'Permanently Delete Bot')}
            </h3>
            <p className="grok-confirm-desc">
              {botConfirmModal.kind === 'archive'
                ? t(
                    `确定要归档「${botConfirmModal.bot.role}」吗？归档后将移至「设置 · 已归档智能体」并保留 14 天，期间可查看只读历史或随时恢复，14 天后自动清理。`,
                    `Archive "${botConfirmModal.bot.role}"? It will move to Settings > Archived Bots for 14 days (read-only history, restorable) before auto-deletion.`,
                  )
                : t(
                    `确定要永久删除智能体「${botConfirmModal.bot.role}」及其所有历史对话与人设文档吗？此操作不可恢复。`,
                    `Permanently delete "${botConfirmModal.bot.role}" and all its conversation history and persona? This cannot be undone.`,
                  )}
            </p>
            <div className="grok-confirm-actions">
              <button
                type="button"
                className="hub-outline-btn"
                disabled={action.busy}
                onClick={() => setBotConfirmModal(null)}
              >
                {t('取消', 'Cancel')}
              </button>
              <button
                type="button"
                className={`grok-done-pill-btn${botConfirmModal.kind === 'delete' ? ' danger' : ''}`}
                disabled={action.busy}
                onClick={() => {
                  if (botConfirmModal.kind === 'archive') {
                    void handleArchiveBot(botConfirmModal.bot);
                  } else {
                    void handleDeleteBot(botConfirmModal.bot);
                  }
                }}
              >
                {action.busy
                  ? t('处理中…', 'Processing…')
                  : botConfirmModal.kind === 'archive'
                    ? t('归档智能体', 'Archive Bot')
                    : t('永久删除智能体', 'Permanently Delete Bot')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 群聊解散并删除二次确认弹窗（先读 authority 最新 scope 冻结 requestId / expectedRevision，未确认可按原 ID 确认） */}
      {roomDeleteModal && (
        <div
          className="grok-confirm-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={t('解散并删除群聊', 'Disband & Delete Group')}
          onClick={() => {
            if (!roomDeleteModal.submitting) {
              roomDeleteFetchSeqRef.current += 1;
              setRoomDeleteModal(null);
            }
          }}
        >
          <div className="grok-confirm-dialog" onClick={e => e.stopPropagation()}>
            <h3 className="grok-confirm-title">{t('解散并删除群聊', 'Disband & Delete Group')}</h3>
            <p className="grok-confirm-desc">
              {roomDeleteModal.loadingLatest
                ? t('正在从权威节点读取最新群聊信息…', 'Reading latest group state from authority node…')
                : t(
                    `确定要解散并删除群聊「${roomDeleteModal.attempt?.title || roomDeleteModal.room.title}」吗？所有设备上的该群聊及全部群历史消息都将被删除，此操作不可恢复。`,
                    `Disband and delete group "${roomDeleteModal.attempt?.title || roomDeleteModal.room.title}"? The group and all its message history across all devices will be deleted. This cannot be undone.`,
                  )}
            </p>
            {roomDeleteModal.error && (
              <ErrorNotice compact error={roomDeleteModal.error} />
            )}
            <div className="grok-confirm-actions">
              <button
                type="button"
                className="hub-outline-btn"
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
                  className="hub-outline-btn"
                  disabled={roomDeleteModal.loadingLatest || roomDeleteModal.submitting}
                  onClick={() => void loadLatestRoomForDelete(roomDeleteModal.room)}
                >
                  {t('重新读取', 'Reload')}
                </button>
              )}
              {roomDeleteModal.attempt && (
                <button
                  type="button"
                  className="grok-done-pill-btn danger"
                  disabled={roomDeleteModal.loadingLatest || roomDeleteModal.submitting}
                  onClick={() => void executeRoomDelete()}
                >
                  {roomDeleteModal.submitting
                    ? t('正在处理…', 'Processing…')
                    : roomDeleteModal.attempt.unconfirmed
                      ? t('按原 ID 确认', 'Confirm Original ID')
                      : t('解散并删除群聊', 'Disband & Delete Group')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 主 Bot hero：复用上游长按/右键/键盘行交互 hook（顶层调用，非 map 内）。 */
function HubPrimaryHero({
  bot,
  preset,
  label,
  onOpen,
  onOpenMenu,
}: {
  bot: UnifiedBotItem;
  preset: GrokAvatarPreset;
  label: string;
  onOpen: () => void;
  onOpenMenu: (position: { x: number; y: number }) => void;
}) {
  const interactions = useConversationRowInteractions({ onOpen, onOpenMenu });
  return (
    <button
      type="button"
      className="hub-hero-button"
      aria-label={label}
      {...interactions}
    >
      <GrokBotAvatar
        preset={preset}
        isPrimary
        starBadge
        platformBadge={<PlatformLogoIcon platform={bot.platform} size={11} />}
        size={88}
      />
      <span className="hub-hero-name" title={bot.role}>{bot.role}</span>
      <span className="hub-bot-host-badge local" title={bot.hostLabel}>
        <PlatformLogoIcon platform={bot.platform} size={12} />
        <span className="hub-bot-host-text">{bot.hostLabel}</span>
      </span>
    </button>
  );
}

/** 普通 Bot 行：ConversationRow 承载点击/长按/键盘菜单，保 host badge 与时间。 */
function HubBotRow({
  item,
  preset,
  isPrimaryActive,
  snippet,
  unread,
  timestampMs,
  pinned,
  onOpen,
  onOpenMenu,
}: {
  item: UnifiedBotItem;
  preset: GrokAvatarPreset;
  isPrimaryActive: boolean;
  snippet: string;
  unread: boolean;
  /** server/meta 最大值，与混排排序一致。 */
  timestampMs: number;
  pinned?: boolean;
  onOpen: () => void;
  onOpenMenu: (position: { x: number; y: number }) => void;
}) {
  return (
    <ConversationRow
      className={`hub-bot-row${item.online === false ? ' is-offline' : ''}`}
      title={item.role}
      preview={snippet}
      timestamp={timestampMs || null}
      unread={unread}
      pinned={pinned}
      avatar={
        <GrokBotAvatar
          preset={preset}
          isPrimary={isPrimaryActive}
          starBadge={isPrimaryActive}
          size={52}
        />
      }
      onOpen={onOpen}
      onOpenMenu={onOpenMenu}
      meta={item.hostLabel}
    />
  );
}

/** 归档 Bot 行：div + 上游 hook 交互；内部操作按钮不触发长按菜单，也不进入聊天。 */
function HubArchivedRow({
  onOpen,
  onOpenMenu,
  children,
}: {
  onOpen: () => void;
  onOpenMenu: (position: { x: number; y: number }) => void;
  children: React.ReactNode;
}) {
  const interactions = useConversationRowInteractions({ onOpen, onOpenMenu });
  // 共享 hook 已忽略嵌套控件起点；move/up/leave 无条件转发，否则按下行文本、
  // 抬起在内按钮时会残留计时器。仅重写 Enter/Space 打开行为。
  return (
    <div
      className="hub-bot-row is-archived"
      style={{ opacity: 0.72 }}
      role="button"
      tabIndex={0}
      {...interactions}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
          return;
        }
        interactions.onKeyDown(e);
      }}
    >
      {children}
    </div>
  );
}

function RemotePendingComposer({
  api,
  identity,
  botId,
  botRole,
  isBotBusy,
  canStop = false,
  stopping = false,
  online,
  onOffline,
  composerMenuOpen,
  onToggleComposerMenu,
  onOpenProfile,
  onRunCommand,
  commandBusy,
  onAbort,
  onAccepted,
  onStarted,
  onPersist,
  onQueued,
  pending,
  fallbackDraft,
  onFallbackTransferred,
  blocked,
  onUnconfirmed,
  onNotSent,
}: {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  botId: string;
  botRole: string;
  isBotBusy: boolean;
  /** 统一活动状态允许停止（排队/准备/运行/让位/失败受理）。 */
  canStop?: boolean;
  /** 停止已受理、正在确认；发送/草稿/上传都不解除它。 */
  stopping?: boolean;
  online: boolean;
  onOffline(): void;
  composerMenuOpen: boolean;
  onToggleComposerMenu(): void;
  onOpenProfile(): void;
  /** 执行 /clear 与 /compact；true 表示服务端已成功（可清命令草稿），false 表示 UI 已切走后不再报错的过期结果。 */
  onRunCommand(command: SlashCommandName): Promise<boolean>;
  /** 顶栏菜单等 Host 侧发起的命令执行中：锁住输入与发送，避免绕过。 */
  commandBusy?: boolean;
  /** 停止此 Bot：调用方等待 Promise；失败由调用方统一提示，此处不吞错。 */
  onAbort(): Promise<unknown>;
  onAccepted(receipt: HostSubmission): void;
  onStarted(requestId: string, text: string, draft: DesktopDraftEntry): void;
  onPersist(requestId: string): boolean;
  onQueued(requestId: string, pendingId: string): void;
  pending?: ChatPending;
  fallbackDraft: string;
  onFallbackTransferred(): void;
  blocked: boolean;
  onUnconfirmed(requestId: string): void;
  onNotSent(requestId: string): void;
}) {
  const t = useText();
  const target = useMemo(() => ({ kind: 'primary' as const, id: botId }), [botId]);
  const drafts = useDrafts({ api, identity, target });
  const [notice, setNotice] = useState('');
  const [imageError, setImageError] = useState('');
  /** 选图/上传在途：禁重复选择与发送（state 驱动 UI disabled）；归属冻结到发起时的 identity/botId/draftKey。 */
  const [imageUploading, setImageUploading] = useState(false);
  const remoteFetcher = useMemo<AttachmentFetcher>(() => {
    return async (attachmentId) => api.call(identity, 'getAttachment', { botId, attachmentId }) as Promise<ImageAttachmentData>;
  }, [api, identity, botId]);

  /** Tauri（Android）界面才有原生选图/拍照；浏览器走 input type=file。 */
  const inTauriUi = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

  /** 上传选图到目标 Host 并把元数据加入草稿；归属冻结在发起时 identity/botId/draftKey。
   *  addAttachment 的 expectedKey 是原子 guard（keyRef 实时比较）：切换 Bot/身份后未完成批次中止，
   *  已上传结果不写新 scope 草稿。相同图片 id（content SHA-256）去重；去重后总数 ≤16，超限整体拒绝。 */
  const uploadRemoteImages = useCallback(async (sources: PickedImageSource[]) => {
    const draftKey = drafts.key;
    if (!draftKey || sources.length === 0) return;
    const frozenIdentity = { ...identity };
    const existing = new Set(drafts.attachments.map((a) => a.id));
    const queued: { source: PickedImageSource; id: string }[] = [];
    for (const source of sources) {
      const id = await attachmentIdOf(source.data);
      if (existing.has(id)) continue;
      existing.add(id);
      queued.push({ source, id });
    }
    if (drafts.attachments.length + queued.length > IMAGE_MAX_COUNT) {
      throw new ImagePickError('IMAGE_TOO_MANY', t(`最多 ${IMAGE_MAX_COUNT} 张图片，本次未上传。`, `At most ${IMAGE_MAX_COUNT} images; nothing uploaded.`));
    }
    const totalBytes = drafts.attachments.reduce((sum, a) => sum + a.size, 0)
      + queued.reduce((sum, item) => sum + item.source.size, 0);
    if (totalBytes > IMAGE_MAX_TOTAL_BYTES) {
      throw new ImagePickError('IMAGE_TOO_LARGE', t(`图片总大小超过 ${IMAGE_MAX_TOTAL_BYTES / 1048576}MB，本次未上传。`, `Total image size exceeds ${IMAGE_MAX_TOTAL_BYTES / 1048576}MB; nothing uploaded.`));
    }
    for (const item of queued) {
      const att = await api.call(frozenIdentity, 'uploadAttachment', {
        botId,
        name: attachmentFileName(item.source.name, item.source.mimeType),
        mimeType: item.source.mimeType,
        data: item.source.data,
      });
      // expectedKey 原子校验：当前 key 已切换（新 Bot/重连/换代）时拒绝，中止剩余批次。
      if (!drafts.addAttachment(att as ImageAttachment, draftKey)) return;
    }
  }, [api, identity, botId, drafts, t]);

  const pickRemoteImages = useCallback((source: 'photos' | 'camera') => {
    if (imageUploading || !drafts.key || Boolean(drafts.attempt) || blocked || Boolean(commandBusy)) return;
    setImageError('');
    const handleSources = async (sources: PickedImageSource[]) => {
      if (sources.length === 0) return;
      try {
        await uploadRemoteImages(sources);
      } catch (error) {
        setImageError(errorText(error));
      }
    };
    setImageUploading(true);
    const release = () => setImageUploading(false);
    if (inTauriUi) {
      void BotHost.pickImages({ source }).then(
        (result) => void handleSources(result.cancelled ? [] : result.images).finally(release),
        (error) => { release(); setImageError(errorText(error)); },
      );
      return;
    }
    pickImagesFromInput({
      onPicked: async (files) => {
        const normalized = await Promise.all(files.map((file) => normalizeImageFile(file, file.name)));
        await handleSources(normalized);
      },
      onSettled: release,
    });
  }, [imageUploading, drafts.key, drafts.attempt, blocked, commandBusy, inTauriUi, uploadRemoteImages]);
  const [recoveryTick, setRecoveryTick] = useState(0);
  const [confirmedConflict, setConfirmedConflict] = useState<{ requestId: string; pendingId: string; original: DesktopDraftEntry; handle?: { key: string; attemptId: string } }>();
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [slashBusy, setSlashBusy] = useState<SlashCommandName>();
  const slashBusyRef = useRef(false);
  const sending = useRef(false);
  const [stopError, setStopError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** 停止与发送并存、独立：不被 attempt/上传/草稿/action.busy 锁禁，只防重复。 */
  const stopBusy = Boolean(stopping);
  const runAbort = async () => {
    if (stopBusy) return;
    setStopError('');
    try {
      await onAbort();
    } catch (error) {
      setStopError(errorText(error));
    }
  };

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!drafts.text) {
      el.style.height = '36px';
    } else {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
    }
  }, [drafts.text]);

  const [transfer, setTransfer] = useState<{ source: string; text: string }>();
  useEffect(() => {
    if (!transfer || !drafts.key || drafts.dirty || drafts.text !== transfer.text) return;
    if (api.snapshot?.state.drafts[drafts.key]?.text !== transfer.text) return;
    if (fallbackDraft === transfer.source) onFallbackTransferred();
    setTransfer(undefined);
    // The offline copy is removed only after the existing draft store confirms the merge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfer, drafts.key, drafts.dirty, drafts.text, api.snapshot, fallbackDraft]);

  const restoredAttempt = useRef('');
  useEffect(() => {
    const attempt = drafts.attempt;
    if (!attempt || attempt.input.kind !== 'primary' || attempt.phase === 'locked' || attempt.phase === 'enqueued' || attempt.phase === 'cleared' || confirmedConflict?.requestId === attempt.input.requestId) return;
    const input = attempt.input;
    if (restoredAttempt.current !== attempt.id) {
      restoredAttempt.current = attempt.id;
      onStarted(input.requestId, input.text, attempt.draft);
      onUnconfirmed(input.requestId);
    }
    if (!online || !api.transportConnected) return;
    let alive = true;
    let reading = false;
    const recover = async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const handle = { key: drafts.key!, attemptId: attempt.id };
        if (!attempt.pendingId && !attempt.cleared) {
          await drafts.reconcile(handle);
          return;
        }
        if (attempt.pendingId) {
          let pending = await api.pending(identity, 'pending_get', { id: attempt.pendingId });
          if (pending && (pending.kind !== 'primary' || pending.requestId !== input.requestId || pending.botId !== botId || pending.targetDeviceId !== identity.targetDeviceId || pending.text !== input.text)) return;
          if (pending?.state === 'sending' || pending?.state === 'unconfirmed') pending = await api.pending(identity, 'pending_reconcile', { id: attempt.pendingId });
          if (pending?.state === 'pending') pending = await api.pending(identity, 'pending_cancel', { id: attempt.pendingId });
          if (!alive) return;
          if (pending?.state === 'rejected' && pending.lastError?.code === 'CANCELLED' && pending.lastError.outcome === 'not-sent') {
            const newer = drafts.conflict ?? api.snapshot?.state.drafts[handle.key];
            const attEqual = (a: DesktopDraftEntry, b: DesktopDraftEntry) => JSON.stringify(a.attachments ?? []) === JSON.stringify(b.attachments ?? []);
            const matches = (draft: DesktopDraftEntry) => Boolean(newer && newer.text === draft.text && JSON.stringify(newer.files) === JSON.stringify(draft.files) && attEqual(newer, draft));
            const changed = newer && (attempt.cleared ? Boolean(newer.text || newer.files.length || (newer.attachments?.length)) && !matches(attempt.draft) : !matches(attempt.draft) && !matches(attempt.baseDraft));
            if (drafts.conflict || changed) {
              setConfirmedConflict({ requestId: input.requestId, pendingId: pending.id, original: attempt.draft, handle });
              return;
            }
            if (attempt.cleared) {
              await api.queueWrite(state => {
                const current = state.drafts[handle.key];
                if (current && (current.text || current.files.length || (current.attachments?.length)) && (current.text !== attempt.draft.text || JSON.stringify(current.files) !== JSON.stringify(attempt.draft.files) || JSON.stringify(current.attachments ?? []) !== JSON.stringify(attempt.draft.attachments ?? []))) throw new Error('草稿已更新，不能覆盖。');
                return { ...state, drafts: { ...state.drafts, [handle.key]: attempt.draft } };
              });
              if (!alive) return;
            }
            drafts.finishSend(handle);
            if (attempt.cleared) {
              drafts.editText(attempt.draft.text);
              attempt.draft.files.forEach(file => drafts.addFile(file));
              (attempt.draft.attachments ?? []).forEach(att => drafts.addAttachment(att));
            }
            onNotSent(input.requestId);
            setNotice(t('请求未发送，草稿已恢复。', 'Request not sent; draft restored.'));
            return;
          }
        }
        const receipt = await api.call(identity, 'getSubmission', { botId, requestId: input.requestId });
        if (!alive || !receipt || receipt.requestId !== input.requestId) return;
        onAccepted(receipt as unknown as HostSubmission);
        if (attempt.cleared || await drafts.confirmCleared(handle) === 'cleared') drafts.finishSend(handle);
      } catch {
        // A failed or missing read does not authorize a resend.
      } finally { reading = false; }
    };
    void recover();
    const timer = window.setInterval(recover, 2000);
    return () => { alive = false; window.clearInterval(timer); };
    // Callbacks are scoped to this mounted bot; identity generation fences old requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, identity.generation, identity.targetDeviceId, botId, online, drafts.key, drafts.attempt?.id, drafts.attempt?.phase, drafts.attempt?.pendingId, drafts.conflict, confirmedConflict?.requestId, recoveryTick]);

  useEffect(() => {
    if (!pending || !blocked || drafts.attempt || !drafts.key || !online || !api.transportConnected || confirmedConflict?.requestId === pending.requestId) return;
    let alive = true;
    let reading = false;
    const recover = async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        let record = pending.pendingId ? await api.pending(identity, 'pending_get', { id: pending.pendingId }) : null;
        if (!record && !pending.pendingId) {
          let cursor: PendingCursor | null = null;
          for (let i = 0; i < 20; i++) {
            const page: PendingListPage = await api.pending(identity, 'pending_list', { options: { limit: 50, cursor } });
            record = page.items.find(item => item.kind === 'primary' && item.requestId === pending.requestId && item.botId === botId && item.targetDeviceId === identity.targetDeviceId) ?? null;
            if (record || !page.nextCursor) break;
            cursor = page.nextCursor;
          }
        }
        if (!record || !alive || record.kind !== 'primary' || record.requestId !== pending.requestId || record.botId !== botId || record.targetDeviceId !== identity.targetDeviceId || record.text !== pending.text) return;
        if (record.state === 'sending' || record.state === 'unconfirmed') record = await api.pending(identity, 'pending_reconcile', { id: record.id });
        if (record.state === 'accepted' && record.receipt) {
          if (alive) onAccepted(record.receipt as unknown as HostSubmission);
          return;
        }
        if (record.state === 'pending') record = await api.pending(identity, 'pending_cancel', { id: record.id });
        if (!alive || record.state !== 'rejected' || record.lastError?.code !== 'CANCELLED' || record.lastError.outcome !== 'not-sent' || !pending.draft) return;
        const draft = pending.draft;
        const currentText = drafts.text;
        const newer = api.snapshot?.state.drafts[drafts.key!];
        if ((currentText && currentText !== draft.text) || (drafts.files.length && JSON.stringify(drafts.files) !== JSON.stringify(draft.files)) ||
          (drafts.attachments.length && JSON.stringify(drafts.attachments) !== JSON.stringify(draft.attachments ?? [])) ||
          (newer && (newer.text || newer.files.length || (newer.attachments?.length)) && (newer.text !== draft.text || JSON.stringify(newer.files) !== JSON.stringify(draft.files) || JSON.stringify(newer.attachments ?? []) !== JSON.stringify(draft.attachments ?? [])))) {
          setConfirmedConflict({ requestId: pending.requestId, pendingId: record.id, original: draft });
          return;
        }
        await api.queueWrite(state => {
          const existing = state.drafts[drafts.key!];
          if (existing && (existing.text || existing.files.length || (existing.attachments?.length)) && (existing.text !== draft.text || JSON.stringify(existing.files) !== JSON.stringify(draft.files) || JSON.stringify(existing.attachments ?? []) !== JSON.stringify(draft.attachments ?? []))) throw new Error('草稿已更新，不能覆盖。');
          return { ...state, drafts: { ...state.drafts, [drafts.key!]: draft } };
        });
        if (!alive) return;
        drafts.editText(draft.text);
        if (!drafts.files.length) draft.files.forEach(file => drafts.addFile(file));
        (draft.attachments ?? []).forEach(att => drafts.addAttachment(att));
        onNotSent(pending.requestId);
        setNotice(t('请求未发送，草稿已恢复。', 'Request not sent; draft restored.'));
      } catch { /* preserve the original request when reconciliation fails */ }
      finally { reading = false; }
    };
    void recover();
    const timer = window.setInterval(recover, 2000);
    return () => { alive = false; window.clearInterval(timer); };
    // Current generation and the persisted request identify the only safe target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.requestId, pending?.pendingId, blocked, drafts.attempt?.id, drafts.key, online, identity.generation, identity.targetDeviceId, api, confirmedConflict?.requestId, recoveryTick]);

  const keepNewerDraft = async () => {
    const conflict = confirmedConflict;
    const key = drafts.key;
    if (!conflict || !key || resolvingConflict) return;
    setResolvingConflict(true);
    try {
      const original = await api.pending(identity, 'pending_get', { id: conflict.pendingId });
      if (!original || original.kind !== 'primary' || original.requestId !== conflict.requestId || original.botId !== botId ||
        original.targetDeviceId !== identity.targetDeviceId || original.state !== 'rejected' ||
        original.lastError?.code !== 'CANCELLED' || original.lastError.outcome !== 'not-sent') {
        throw new Error(t('尚未确认请求已取消，无法结束旧尝试。', 'Cancellation is not confirmed; the original attempt remains locked.'));
      }
      if (!api.snapshot) throw new Error(t('持久草稿尚未加载。', 'Saved draft is not loaded.'));
      if (conflict.handle && drafts.attempt?.id === conflict.handle.attemptId) {
        if (drafts.conflict && !drafts.attempt.cleared) {
          const verified = await drafts.reconcile(conflict.handle);
          if (!verified.found || verified.recordState !== 'rejected') throw new Error(verified.note || '无法核实旧请求');
          const adopted = drafts.adoptNewerDraftAndFinish(conflict.handle);
          if (!adopted.ok) throw new Error(adopted.error || '无法采用新版草稿');
        } else {
          drafts.finishSend(conflict.handle);
        }
      }
      const adopted = await drafts.adoptPersistedDraft(key);
      if (!adopted.ok) throw new Error(adopted.error || '无法读取新版草稿');
      onNotSent(conflict.requestId);
      setConfirmedConflict(undefined);
      setNotice(t('已保留新版草稿，旧请求已取消。', 'Kept the newer draft; the original request was cancelled.'));
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setResolvingConflict(false);
    }
  };

  // 命令先等后端成功，成功后才走现有草稿写入路径清空；失败/离线保留命令草稿。
  const commandLocked = Boolean(commandBusy) || Boolean(slashBusy);
  const runCommand = async (command: SlashCommandName) => {
    if (sending.current || slashBusyRef.current || commandLocked || blocked || drafts.attempt) return;
    if (!online || !api.transportConnected) {
      onOffline();
      return;
    }
    slashBusyRef.current = true;
    setSlashBusy(command);
    // 进度提示由 Host 的 clearNotice（status）统一展示；此处不重复写错误卡片。
    setNotice('');
    try {
      const applied = await onRunCommand(command);
      // 仅服务端确认成功时才清命令草稿；过期 scope 的 false 不清草稿。
      if (applied) {
        drafts.editText('');
        setNotice('');
      }
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      slashBusyRef.current = false;
      setSlashBusy(undefined);
    }
  };

  const slash = useSlashAutocomplete({
    text: drafts.text,
    disabled: Boolean(drafts.attempt) || blocked || commandLocked || Boolean(fallbackDraft),
    onText: text => drafts.editText(text),
    onRun: command => void runCommand(command),
  });

  const send = async () => {
    if (sending.current || commandLocked || blocked || fallbackDraft || imageUploading) return;
    const trimmed = drafts.text.trim();
    const attachmentIds = drafts.attachments.map((a) => a.id);
    if (!trimmed && attachmentIds.length === 0) return;
    const command = parseSlashCommand(trimmed);
    if (command && attachmentIds.length === 0) {
      await runCommand(command);
      return;
    }
    if (!online || !api.transportConnected) {
      onOffline();
      return;
    }
    const text =
      trimmed +
      (drafts.files.length
        ? '\n' + drafts.files.map(file => `[文件路径引用，未上传] ${file.path}`).join('\n')
        : '');
    const started = drafts.beginSend({
      kind: 'primary',
      targetDeviceId: identity.targetDeviceId,
      botId,
      requestId: uuid(),
      text,
      ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
    });
    if (!started) return;
    sending.current = true;
    if (started.attempt.input.kind !== 'primary') return;
    const requestId = started.attempt.input.requestId;
    onStarted(requestId, text, started.attempt.draft);
    setNotice('');
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (!onPersist(requestId)) {
        drafts.markNotSent(started.handle, '无法保存请求');
        drafts.releaseIfNotSent(started.handle);
        onNotSent(requestId);
        setNotice(t('无法保存请求，未发送。', 'Cannot save request; not sent.'));
        return;
      }
      await drafts.waitQuiet(started.handle);
      if (!api.transportConnected) {
        drafts.markNotSent(started.handle, '目标离线');
        drafts.releaseIfNotSent(started.handle);
        onNotSent(requestId);
        onOffline();
        return;
      }
      let pending;
      try {
        pending = await api.pending(identity, 'pending_enqueue', { input: started.attempt.input });
      } catch (error) {
        const message = errorText(error);
        if ((error as { outcome?: string })?.outcome === 'not-sent') { drafts.markNotSent(started.handle, message); drafts.releaseIfNotSent(started.handle); onNotSent(requestId); }
        else { drafts.markUnconfirmed(started.handle); onUnconfirmed(requestId); }
        setNotice(`${message} · requestId ${started.attempt.input.kind === 'primary' ? started.attempt.input.requestId : ''}`);
        return;
      }
      drafts.setPending(started.handle, pending.id);
      onQueued(requestId, pending.id);
      const cleared = await drafts.confirmCleared(started.handle);
      if (cleared !== 'cleared') {
        const message = t(
          '草稿未清空，队列未发送；请对账并保留新版草稿。',
          'Draft not cleared; queued item not sent. Reconcile before continuing.',
        );
        drafts.markFailed(started.handle, message);
        onUnconfirmed(requestId);
        setNotice(message);
        return;
      }
      if (!api.transportConnected) {
        drafts.markUnconfirmed(started.handle);
        onUnconfirmed(requestId);
        setNotice(t('连接中断，请按原 ID 确认结果。', 'Connection interrupted; reconcile the original ID.'));
        return;
      }
      try {
        const sent = await api.pending(identity, 'pending_send', { id: pending.id });
        if (sent.state === 'accepted') drafts.finishSend(started.handle);
        else drafts.markUnconfirmed(started.handle);
        if (sent.state === 'accepted') {
          setNotice('');
          if (sent.receipt) onAccepted(sent.receipt as unknown as HostSubmission);
        } else {
          onUnconfirmed(requestId);
          setNotice(`${sent.state} · ${pending.id}`);
        }
      } catch (error) {
        drafts.markUnconfirmed(started.handle);
        onUnconfirmed(requestId);
        setNotice(`${t('回执未确认，请按原 ID 对账', 'Receipt unconfirmed; reconcile the original ID')} · ${pending.id} · ${errorText(error)}`);
      }
    } finally {
      sending.current = false;
    }
  };

  return (
    <>
      <ErrorNotice
        error={drafts.error || notice || stopError}
        compact
        onDismiss={notice && !drafts.error ? () => setNotice('') : undefined}
      />
      {fallbackDraft && (
        <section className="grok-card-group" role="status">
          <p>{t('离线输入已保留：', 'Offline draft retained:')} {fallbackDraft}</p>
          <button type="button" className="hub-outline-btn" disabled={!drafts.key || Boolean(drafts.attempt) || Boolean(transfer)} onClick={() => {
            const text = drafts.text === fallbackDraft ? drafts.text : [drafts.text, fallbackDraft].filter(Boolean).join('\n');
            setTransfer({ source: fallbackDraft, text });
            drafts.editText(text);
          }}>{t('合并到草稿', 'Merge into draft')}</button>
        </section>
      )}
      {confirmedConflict && (
        <section className="grok-card-group" aria-label={t('草稿冲突', 'Draft conflict')}>
          <p>{t('原请求已确认未发送。请先查看或复制原文，再选择保留新版草稿。', 'The original request was not sent. Review or copy it before keeping the newer draft.')}</p>
          <textarea readOnly rows={4} value={confirmedConflict.original.text} aria-label={t('原草稿，可选择复制', 'Original draft, selectable for copying')} style={{ width: '100%' }} />
          {confirmedConflict.original.files.map((file, index) => <div key={`${file.path}:${index}`} className="pre-wrap">{file.name}: {file.path}</div>)}
          <button type="button" className="hub-outline-btn" disabled={resolvingConflict} onClick={() => void keepNewerDraft()}>
            {t('保留新版草稿，结束旧尝试', 'Keep newer draft and end original attempt')}
          </button>
        </section>
      )}
      {(blocked || (drafts.attempt && !['locked', 'enqueued', 'cleared'].includes(drafts.attempt.phase))) && (
        <section className="grok-card-group grok-pending-freeze-card" role="status" style={{ marginBottom: 8 }}>
          <div className="grok-pending-freeze-head">
            <span className="grok-pending-freeze-badge">{t('发送结果待确认', 'Send result unconfirmed')}</span>
            <code className="grok-pending-freeze-id">{pending?.requestId || (drafts.attempt?.input.kind === 'primary' ? drafts.attempt.input.requestId : '')}</code>
          </div>
          <button type="button" className="grok-done-pill-btn" onClick={() => setRecoveryTick(value => value + 1)}>
            {t('按原 ID 对账', 'Reconcile ID')}
          </button>
        </section>
      )}

      {drafts.files.length > 0 && (
        <div className="grok-composer-files-row">
          {drafts.files.map((file, index) => (
            <span key={`${file.path}:${index}`} className="grok-model-quick-chip active">
              <span>{file.name}</span>
              <button
                type="button"
                disabled={Boolean(drafts.attempt) || blocked}
                onClick={() => drafts.removeFile(index)}
                aria-label={t('移除', 'Remove')}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {drafts.savePaused && (
        <div style={{ marginBottom: 6 }}>
          <button type="button" className="hub-outline-btn" onClick={drafts.retrySave}>
            {t('重试保存草稿', 'Retry draft save')}
          </button>
        </div>
      )}

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
          <button type="button" role="menuitem" onClick={onOpenProfile}>
            <User size={18} />
            <span>{t('查看 Bot 资料与设定', 'View Bot Profile & Settings')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={drafts.attachments.length >= IMAGE_MAX_COUNT || imageUploading || Boolean(drafts.attempt) || blocked || commandLocked}
            onClick={() => {
              onToggleComposerMenu();
              pickRemoteImages('photos');
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
              disabled={drafts.attachments.length >= IMAGE_MAX_COUNT || imageUploading || Boolean(drafts.attempt) || blocked || commandLocked}
              onClick={() => {
                onToggleComposerMenu();
                pickRemoteImages('camera');
              }}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              <span>{t('拍照', 'Camera')}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => void runCommand('/clear')}
          >
            <Trash2 size={18} />
            <span>{t('清空当前对话历史 (/clear)', 'Clear conversation history (/clear)')}</span>
          </button>
        </div>
      )}

      {imageError ? <ErrorNotice compact error={imageError} onDismiss={() => setImageError('')} /> : null}
      {drafts.attachments.length > 0 ? (
        <div className="attachments" role="group" aria-label={t('附件', 'Attachments')}>
          {drafts.attachments.map((att, index) => (
            <ImageAttachmentThumb
              key={att.id}
              attachment={att}
              fetcher={remoteFetcher}
              disabled={Boolean(drafts.attempt) || blocked || commandLocked}
              onRemove={() => drafts.removeAttachment(index)}
              t={t}
            />
          ))}
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
            ref={textareaRef}
            rows={1}
            className={drafts.text ? 'has-text' : 'is-empty'}
            value={drafts.text}
            disabled={Boolean(drafts.attempt) || blocked || commandLocked}
            {...slash.textareaProps}
            onChange={event => drafts.editText(event.target.value)}
            aria-label={t('消息', 'Message')}
            placeholder={
              botRole.length > 8
                ? t('发消息…', 'Message…')
                : t(`向 ${botRole} 发消息…`, `Message ${botRole}…`)
            }
            onKeyDown={e => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (slash.onKeyDown(e)) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />

          {drafts.text.trim() || drafts.attachments.length > 0 ? (
            <button
              type="button"
              className="grok-composer-action-pill send"
              disabled={(!drafts.text.trim() && drafts.attachments.length === 0) || imageUploading || Boolean(drafts.attempt) || blocked || Boolean(fallbackDraft) || commandLocked}
              onClick={() => void send()}
              aria-label={t('发送', 'Send')}
            >
              <ArrowUp size={18} />
            </button>
          ) : !canStop && !isBotBusy ? (
            <button
              type="button"
              className="grok-composer-action-pill voice"
              aria-label={t('查看资料与语音设定', 'Bot profile & voice')}
              onClick={onOpenProfile}
            >
              <AudioLines size={18} />
            </button>
          ) : null}

          {/* 停止与发送并存：排队/准备/失败受理/草稿/附件状态下均可停止；不被发送/上传/草稿锁禁用。 */}
          {canStop || stopBusy ? (
            <button
              type="button"
              className="grok-composer-action-pill stop"
              aria-label={t('停止此 Bot', 'Stop this bot')}
              disabled={stopBusy}
              onClick={() => void runAbort()}
            >
              {stopBusy ? <RefreshCw size={14} className="grok-spin" /> : <Square size={15} />}
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

function HubSettingsView({
  onBack,
  ensureRemoteApi,
  remoteProfiles,
  remoteIdentity,
  remoteConnected,
  remoteDevices,
  setRemoteDevices,
  onRemoteUpdated,
  archivedCount,
  onOpenArchivedBots,
  onOpenModelSheet,
  onOpenSystemSettings,
}: {
  onBack(): void;
  ensureRemoteApi(): Promise<DesktopPanelApi | null>;
  remoteProfiles: DesktopUiProfile[];
  remoteIdentity: DesktopIdentity | null;
  remoteConnected: boolean;
  remoteDevices: DevicesDirectoryItem[];
  setRemoteDevices(items: DevicesDirectoryItem[]): void;
  onRemoteUpdated(): void;
  archivedCount: number;
  onOpenArchivedBots(): void;
  onOpenModelSheet?(): void;
  onOpenSystemSettings?(): void;
}) {
  const t = useText();
  const action = useAction();
  const centerConn = useCenterConnection();

  const [editingCenter, setEditingCenter] = useState(false);
  const [renamingDeviceId, setRenamingDeviceId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(remoteIdentity?.profileId ?? null);
  const [token, setToken] = useState('');
  const [ca, setCa] = useState('');
  const [addingRemote, setAddingRemote] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formKind, setFormKind] = useState<'local' | 'relay'>('relay');
  const [formUrl, setFormUrl] = useState('');
  const [formDeviceId, setFormDeviceId] = useState('');

  const [hostSettings, setHostSettings] = useState<HostSettingsPayload>();
  const [settingsJson, setSettingsJson] = useState('');
  const [credJson, setCredJson] = useState('');
  const [voice, setVoice] = useState<HostVoiceSettings>();
  const [showLocalConfig, setShowLocalConfig] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'basic' | 'advanced'>('basic');

  useEffect(() => {
    void ensureRemoteApi();
    void BotHost.voiceSettings()
      .then(v => setVoice(v))
      .catch(() => {});
  }, [ensureRemoteApi]);

  const saveRemoteProfile = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const api = await ensureRemoteApi();
      if (!api) throw new Error(t('当前环境不支持远程连接组件', 'Remote client unavailable'));
      const id = `p-${Date.now().toString(36)}-${uuid().slice(0, 6)}`;
      const next: DesktopUiProfile =
        formKind === 'local'
          ? {
              id,
              title: formTitle.trim() || formUrl.trim(),
              kind: 'local',
              url: formUrl.trim(),
              ...(formDeviceId.trim() ? { expectedDeviceId: formDeviceId.trim() } : {}),
            }
          : {
              id,
              title: formTitle.trim() || formUrl.trim(),
              kind: 'relay',
              url: formUrl.trim(),
              deviceId: formDeviceId.trim(),
            };
      await (api as DesktopPanelApi & { queueWrite(fn: (s: any) => any): Promise<any> }).queueWrite(s => ({
        ...s,
        profiles: [...s.profiles, next],
      }));
      setFormTitle('');
      setFormUrl('');
      setFormDeviceId('');
      setAddingRemote(false);
      setSelectedProfileId(next.id);
    });
  };

  const deleteRemoteProfile = (profileId: string) =>
    action.run(async () => {
      const api = await ensureRemoteApi();
      if (!api) return;
      await (api as DesktopPanelApi & { queueWrite(fn: (s: any) => any): Promise<any> }).queueWrite(s => ({
        ...s,
        profiles: s.profiles.filter((p: DesktopUiProfile) => p.id !== profileId),
      }));
      if (selectedProfileId === profileId) setSelectedProfileId(null);
    });

  const connectRemoteProfile = () =>
    action.run(async () => {
      const api = await ensureRemoteApi();
      const profile = remoteProfiles.find(p => p.id === (selectedProfileId ?? remoteProfiles[0]?.id));
      if (!api || !profile || !token.trim()) return;
      const input: DesktopConnectionInput =
        profile.kind === 'local'
          ? {
              kind: 'local',
              url: profile.url,
              token: token.trim(),
              ...(profile.expectedDeviceId ? { expectedDeviceId: profile.expectedDeviceId } : {}),
            }
          : {
              kind: 'relay',
              url: profile.url,
              deviceId: profile.deviceId,
              token: token.trim(),
              ...(ca.trim() ? { ca: ca.trim() } : {}),
            };
      api.setTransportConnected(false);
      api.setIdentity(null);
      try {
        const status = await api.broker(
          { profileId: profile.id, targetDeviceId: '', generation: 0, kind: profile.kind },
          'connect',
          { connection: input },
        );
        let targetDeviceId = '';
        if (status.connection && status.connection.kind === 'local') {
          targetDeviceId = status.connection.deviceId ?? '';
        }
        const newIdentity = api.setIdentity({
          profileId: profile.id,
          targetDeviceId,
          kind: profile.kind,
        });
        const isConn = status.phase === 'connected';
        api.setTransportConnected(isConn);
        if (isConn && newIdentity) {
          const page = await api.broker(newIdentity, 'devices', { limit: 20, cursor: null });
          setRemoteDevices(page.items);
          if (profile.kind === 'relay' && page.items.length === 1) {
            api.setIdentity({
              profileId: profile.id,
              targetDeviceId: page.items[0].deviceId,
              kind: 'relay',
            });
          }
          onRemoteUpdated();
        }
      } finally {
        setToken('');
        setCa('');
      }
    });

  const disconnectRemote = () =>
    action.run(async () => {
      const api = await ensureRemoteApi();
      if (!api || !remoteIdentity) return;
      api.setTransportConnected(false);
      await api.broker(remoteIdentity, 'disconnect', {});
      onRemoteUpdated();
    });

  const toggleLocalConfig = () => {
    const next = !showLocalConfig;
    setShowLocalConfig(next);
    if (next && !hostSettings) {
      void BotHost.settingsGet()
        .then(payload => {
          setHostSettings(payload);
          setSettingsJson(JSON.stringify(payload.settings, null, 2));
        })
        .catch(() => {});
    }
  };

  const saveLocalSettings = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      if (!hostSettings) return;
      const parsed = JSON.parse(settingsJson) as HostSettings;
      const updated = await BotHost.settingsSet({
        input: { expectedRevision: hostSettings.revision, settings: parsed },
      });
      setHostSettings(updated);
      setSettingsJson(JSON.stringify(updated.settings, null, 2));
    });
  };

  const saveLocalCredentials = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const aliases = credJson.trim() ? (JSON.parse(credJson) as Record<string, unknown>) : {};
      await BotHost.saveCredentials({ aliases });
      setCredJson('');
    });
  };

  const activeProfile = remoteProfiles.find(p => p.id === (selectedProfileId ?? remoteProfiles[0]?.id));
  const showCenterForm = !centerConn.ready || editingCenter;

  return (
    <main className="grok-subpage grok-page-enter">
      <header className="grok-subpage-topbar">
        <button type="button" className="grok-floating-circle-btn" onClick={onBack} aria-label={t('返回', 'Back')}>
          <ArrowLeft size={20} />
        </button>
        <h2 className="grok-subpage-header-title">{t('设置', 'Settings')}</h2>
        <span style={{ width: 44 }} />
      </header>

      <div className="grok-subpage-scroll">
        <div className="grok-segmented-tabs" role="tablist" aria-label={t('设置分栏', 'Settings tabs')} style={{ marginBottom: 14 }}>
          <button
            type="button"
            role="tab"
            aria-selected={settingsTab === 'basic'}
            className={settingsTab === 'basic' ? 'active' : undefined}
            onClick={() => setSettingsTab('basic')}
          >
            {t('常规设置', 'General')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={settingsTab === 'advanced'}
            className={settingsTab === 'advanced' ? 'active' : undefined}
            onClick={() => setSettingsTab('advanced')}
          >
            {t('高级设置', 'Advanced')}
          </button>
        </div>

        {settingsTab === 'basic' && <>
        {/* Section 0: Center Connection (Moved from top of Bot Hub into Settings) */}
        <div className="grok-field-section">
          <div className="grok-provider-group-head">
            <label className="grok-section-label">{t('中心连接', 'Center Connection')}</label>
            {centerConn.ready && (
              <button
                type="button"
                className="grok-provider-edit-link"
                onClick={() => setEditingCenter(v => !v)}
              >
                {editingCenter ? t('收起', 'Collapse') : t('更换中心连接', 'Change Center')}
              </button>
            )}
          </div>

          <section className="grok-card-group">
            <div className="grok-card-row no-active">
              <Globe size={20} className="grok-row-icon" />
              <div className="grok-model-row-main">
                <span className="grok-row-label">
                  {centerConn.ready
                    ? centerConn.status?.centerUrl || centerConn.url || t('已连接中心', 'Center Connected')
                    : centerConn.connecting
                      ? t('正在后台连接中心…', 'Connecting to center…')
                      : t('未连接中心服务', 'Center Disconnected')}
                </span>
                <small className="grok-model-row-sub">
                  {centerConn.ready
                    ? `${t('设备标识：', 'Device: ')}${centerConn.deviceId || centerConn.saved?.deviceId || 'android'}`
                    : centerConn.saved?.url
                      ? `${t('已保存地址：', 'Saved: ')}${centerConn.saved.url}`
                      : t('配置中心地址与令牌以同步多端智能体', 'Configure center URL & token to sync bots across devices')}
                </small>
              </div>
              <span className={`hub-online-pill${centerConn.ready ? '' : ' is-offline'}`}>
                {centerConn.connecting
                  ? t('连接中', 'Syncing')
                  : centerConn.ready
                    ? t('已连接', 'Connected')
                    : t('未连接', 'Offline')}
              </span>
            </div>

            {centerConn.ready && !editingCenter && (
              <>
                <button
                  type="button"
                  className="grok-card-row"
                  onClick={() => centerConn.openManagement()}
                >
                  <ExternalLink size={19} className="grok-row-icon" />
                  <span className="grok-row-label">{t('在浏览器中打开中心管理', 'Open Center Management')}</span>
                  <ChevronRight size={18} className="grok-row-chevron" />
                </button>
                <div className="grok-card-row no-active" style={{ justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    type="button"
                    className="hub-outline-btn"
                    disabled={centerConn.busy}
                    onClick={() => setEditingCenter(true)}
                  >
                    {t('更换中心连接', 'Change Center')}
                  </button>
                  <button
                    type="button"
                    className="hub-outline-btn"
                    disabled={centerConn.busy}
                    onClick={() => void centerConn.disconnect()}
                  >
                    {t('断开中心', 'Disconnect')}
                  </button>
                </div>
              </>
            )}

            {showCenterForm && (
              <>
                <label className="grok-card-row grok-input-row">
                  <span className="grok-input-label">{t('中心地址', 'Center URL')}</span>
                  <input
                    className="grok-inline-input"
                    inputMode="url"
                    value={centerConn.url}
                    onChange={e => centerConn.setUrl(e.target.value)}
                    placeholder="https://127.0.0.1:4318"
                  />
                </label>

                <label className="grok-card-row grok-input-row">
                  <span className="grok-input-label">{t('设备标识', 'Device ID')}</span>
                  <input
                    className="grok-inline-input"
                    value={centerConn.deviceId}
                    onChange={e => centerConn.setDeviceId(e.target.value)}
                    placeholder="android-client"
                  />
                </label>

                <label className="grok-card-row grok-input-row">
                  <span className="grok-input-label">{t('客户端令牌', 'Client Token')}</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="grok-inline-input"
                    value={centerConn.token}
                    onChange={e => centerConn.setToken(e.target.value)}
                    placeholder={
                      centerConn.matchesSaved
                        ? t('留空使用已保存令牌', 'Blank to use saved token')
                        : t('输入中心访问令牌', 'Enter client token')
                    }
                  />
                </label>

                {centerConn.error && (
                  <div className="grok-card-row no-active">
                    <ErrorNotice error={centerConn.error} compact onDismiss={() => centerConn.setError('')} />
                  </div>
                )}

                <div className="grok-card-row no-active" style={{ justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 }}>
                  {centerConn.saved?.url && (
                    <button
                      type="button"
                      className="hub-outline-btn"
                      disabled={centerConn.busy}
                      onClick={() => void centerConn.disconnect()}
                    >
                      {t('断开并清除凭据', 'Clear Saved')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="hub-outline-btn"
                    disabled={centerConn.busy}
                    onClick={() => void centerConn.stopLocalHost()}
                  >
                    {t('退出客户端', 'Exit Client')}
                  </button>
                  {centerConn.matchesSaved && !centerConn.token.trim() && (
                    <button
                      type="button"
                      className="hub-outline-btn"
                      disabled={centerConn.busy}
                      onClick={() =>
                        void centerConn.connect().then(() => {
                          setEditingCenter(false);
                        })
                      }
                    >
                      {t('用已存凭据重连', 'Reconnect Saved')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="grok-done-pill-btn"
                    disabled={
                      centerConn.busy ||
                      !centerConn.url.trim() ||
                      !centerConn.deviceId.trim() ||
                      (!centerConn.token.trim() && !centerConn.matchesSaved)
                    }
                    onClick={() =>
                      void centerConn
                        .connect()
                        .then(() => {
                          setEditingCenter(false);
                        })
                    }
                  >
                    {centerConn.preparing
                      ? t('正在启动本机节点…', 'Starting Host…')
                      : centerConn.busy
                        ? t('连接中…', 'Connecting…')
                        : t('连接中心', 'Connect Center')}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>

        {/* Section 1: Models & Voice */}
        <div className="grok-field-section">
          <label className="grok-section-label">{t('模型与语音', 'Models & Voice')}</label>
          <section className="grok-card-group">
            {onOpenModelSheet && (
              <button type="button" className="grok-card-row" onClick={onOpenModelSheet}>
                <Cpu size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('模型与服务商', 'Providers & Models')}</span>
                <span className="grok-row-value">{t('配置 API 与常用模型', 'Manage')}</span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>
            )}

            <div className="grok-card-row no-active">
              <AudioLines size={20} className="grok-row-icon" />
              <span className="grok-row-label">{t('语音朗读倍速', 'Speech Rate')}</span>
              <label className="grok-select-wrap">
                <select
                  value={String(voice?.speechRate ?? 1)}
                  onChange={e =>
                    void action.run(async () => {
                      const current = voice ?? (await BotHost.voiceSettings());
                      const next = { ...current, speechRate: Number(e.target.value) };
                      await BotHost.saveVoiceSettings({ settings: next as HostVoiceSaveInput });
                      setVoice(await BotHost.voiceSettings());
                    })
                  }
                >
                  {[0.75, 1, 1.25, 1.5, 2].map(r => (
                    <option key={r} value={String(r)}>
                      {r}×
                    </option>
                  ))}
                </select>
                <ChevronsUpDown size={15} />
              </label>
            </div>
          </section>
          <p className="grok-card-footnote">
            {t(
              '支持添加 DeepSeek、OpenAI、Anthropic、Gemini 或自定义服务商，并收藏 ★ 常用模型。',
              'Configure built-in or custom providers and pin favorite models.',
            )}
          </p>
        </div>

        {/* Section 2: Archived Bots & Lifecycle */}
        <div className="grok-field-section">
          <label className="grok-section-label">{t('智能体与归档', 'Bots & Archive')}</label>
          <section className="grok-card-group">
            <button type="button" className="grok-card-row" onClick={onOpenArchivedBots}>
              <Archive size={20} className="grok-row-icon" />
              <span className="grok-row-label">
                {t(`已归档智能体 (${archivedCount})`, `Archived Bots (${archivedCount})`)}
              </span>
              <span className="grok-row-value">{t('14 天后自动清理', '14d auto-delete')}</span>
              <ChevronRight size={18} className="grok-row-chevron" />
            </button>
          </section>
        </div>

        {/* Section 3: System Permissions & Console */}
        <div className="grok-field-section">
          <label className="grok-section-label">{t('系统与控制台', 'System & Console')}</label>
          <section className="grok-card-group">
            {onOpenSystemSettings && (
              <button type="button" className="grok-card-row" onClick={onOpenSystemSettings}>
                <Settings size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('系统权限与设置', 'System permissions & settings')}</span>
                <span className="grok-row-value">{t('Shizuku、唤醒词、外观', 'Permissions & Theme')}</span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>
            )}

            <button
              type="button"
              className="grok-card-row"
              onClick={() => void openCenterManagement()}
            >
              <ExternalLink size={20} className="grok-row-icon" />
              <span className="grok-row-label">{t('中心管理控制台', 'Center Management Console')}</span>
              <span className="grok-row-value">{t('浏览器打开', 'Open in browser')}</span>
              <ChevronRight size={18} className="grok-row-chevron" />
            </button>
          </section>
        </div>
        </>}

        {settingsTab === 'advanced' && <>
        <div className="grok-field-section">
          <label className="grok-section-label">{t('中心连接进阶参数', 'Center Advanced TLS & Host Token')}</label>
          <section className="grok-card-group">
            <label className="grok-card-row grok-input-row">
              <span className="grok-input-label">{t('本机节点令牌', 'Host Token')}</span>
              <input
                type="password"
                autoComplete="new-password"
                className="grok-inline-input"
                value={centerConn.hostToken}
                onChange={e => centerConn.setHostToken(e.target.value)}
                placeholder={t('选填，留空保持本机节点令牌不变', 'Optional; leave blank to keep local Host token')}
              />
            </label>

            <label className="grok-card-row grok-input-row">
              <span className="grok-input-label">{t('CA 证书', 'CA PEM')}</span>
              <input
                className="grok-inline-input"
                value={centerConn.ca}
                onChange={e => centerConn.setCa(e.target.value)}
                placeholder={t('自签名证书 PEM（选填）', 'Optional self-signed PEM')}
              />
            </label>
          </section>
          <p className="grok-card-footnote">
            {t('仅在使用自签证书中心或需单独指定本机 Host 设备令牌时填写。', 'Only needed for self-signed TLS certificates or custom local Host tokens.')}
          </p>
        </div>

        {/* Section 2: Remote Connections */}
        <div className="grok-field-section">
          <div className="grok-provider-group-head">
            <label className="grok-section-label">{t('自定义远程节点 / 直连配置', 'Custom Remote Hosts')}</label>
            <button
              type="button"
              className="grok-provider-edit-link"
              onClick={() => setAddingRemote(v => !v)}
            >
              {addingRemote ? t('取消', 'Cancel') : t('＋ 添加节点', '+ Add Host')}
            </button>
          </div>

          {addingRemote && (
            <form className="grok-card-group" onSubmit={saveRemoteProfile} style={{ marginBottom: 10 }}>
              <label className="grok-card-row grok-input-row">
                <span className="grok-input-label">{t('节点名称', 'Name')}</span>
                <input
                  required
                  className="grok-inline-input"
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                  placeholder={t('例如：家里工作站', 'e.g. Home Workstation')}
                />
              </label>

              <div className="grok-card-row no-active">
                <span className="grok-row-label">{t('连接方式', 'Mode')}</span>
                <label className="grok-select-wrap">
                  <select value={formKind} onChange={e => setFormKind(e.target.value as 'local' | 'relay')}>
                    <option value="relay">{t('中继服务 (Relay)', 'Relay')}</option>
                    <option value="local">{t('直连 (WebSocket)', 'Direct WebSocket')}</option>
                  </select>
                  <ChevronsUpDown size={15} />
                </label>
              </div>

              <label className="grok-card-row grok-input-row">
                <span className="grok-input-label">{t('服务地址', 'Server URL')}</span>
                <input
                  required
                  className="grok-inline-input"
                  value={formUrl}
                  onChange={e => setFormUrl(e.target.value)}
                  placeholder="wss://..."
                />
              </label>

              <label className="grok-card-row grok-input-row">
                <span className="grok-input-label">
                  {formKind === 'relay' ? t('设备标识', 'Device ID') : t('目标设备 ID', 'Target ID')}
                </span>
                <input
                  required={formKind === 'relay'}
                  className="grok-inline-input"
                  value={formDeviceId}
                  onChange={e => setFormDeviceId(e.target.value)}
                  placeholder={formKind === 'relay' ? t('必填', 'Required') : t('选填', 'Optional')}
                />
              </label>

              <div className="grok-card-row no-active" style={{ justifyContent: 'flex-end' }}>
                <button type="submit" className="grok-done-pill-btn" disabled={action.busy}>
                  {t('保存节点', 'Save Host')}
                </button>
              </div>
            </form>
          )}

          <section className="grok-card-group">
            {remoteProfiles.length === 0 ? (
              <button
                type="button"
                className="grok-card-row"
                onClick={() => setAddingRemote(true)}
              >
                <Server size={20} className="grok-row-icon" />
                <span className="grok-row-label">{t('添加远程节点', 'Add Remote Host')}</span>
                <span className="grok-row-value">{t('默认本机运行', 'Local only')}</span>
                <ChevronRight size={18} className="grok-row-chevron" />
              </button>
            ) : (
              <>
                {remoteProfiles.map(p => {
                  const active = (selectedProfileId ?? remoteProfiles[0]?.id) === p.id;
                  const isConnectedProfile = remoteConnected && remoteIdentity?.profileId === p.id;
                  return (
                    <div key={p.id} className={`grok-card-row grok-model-item-row${active ? ' active' : ''}`}>
                      <button
                        type="button"
                        className="grok-model-item-select"
                        onClick={() => setSelectedProfileId(p.id)}
                      >
                        <div className="grok-model-row-main">
                          <span className="grok-row-label">{p.title}</span>
                          <small className="grok-model-row-sub">{`${p.kind} · ${p.url}`}</small>
                        </div>
                      </button>
                      <div className="grok-model-item-right">
                        {isConnectedProfile && <span className="hub-online-pill">{t('已连接', 'Connected')}</span>}
                        <button
                          type="button"
                          className="grok-schedule-icon-btn danger"
                          aria-label={t('删除节点', 'Remove host')}
                          onClick={() => void deleteRemoteProfile(p.id)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  );
                })}

                <label className="grok-card-row grok-input-row">
                  <span className="grok-input-label">{t('连接令牌', 'Token')}</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="grok-inline-input"
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    placeholder={t('输入访问 Token', 'Enter access token')}
                  />
                </label>

                {activeProfile?.kind === 'relay' && (
                  <label className="grok-card-row grok-input-row">
                    <span className="grok-input-label">{t('CA 证书', 'CA PEM')}</span>
                    <input
                      className="grok-inline-input"
                      value={ca}
                      onChange={e => setCa(e.target.value)}
                      placeholder={t('选填 PEM', 'Optional PEM')}
                    />
                  </label>
                )}

                <div className="grok-card-row no-active" style={{ justifyContent: 'flex-end', gap: 8 }}>
                  {remoteConnected && (
                    <button
                      type="button"
                      className="hub-outline-btn"
                      disabled={action.busy}
                      onClick={() => void disconnectRemote()}
                    >
                      {t('断开连接', 'Disconnect')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="grok-done-pill-btn"
                    disabled={action.busy || !token.trim()}
                    onClick={() => void connectRemoteProfile()}
                  >
                    {t('连接节点', 'Connect')}
                  </button>
                </div>

                {remoteConnected && remoteIdentity?.kind === 'relay' && remoteDevices.map(dev => (
                  <div className="grok-card-row no-active" key={dev.deviceId} style={{ gap: 8 }}>
                    <span
                      className={`hub-bot-host-badge remote${dev.online ? '' : ' is-offline'}`}
                      style={{ maxWidth: 'none' }}
                    >
                      <PlatformLogoIcon platform={dev.platform} size={12} />
                    </span>
                    {renamingDeviceId === dev.deviceId ? (
                      <>
                        <input
                          className="grok-inline-input"
                          style={{ textAlign: 'left', flex: 1 }}
                          value={renameDraft}
                          onChange={e => setRenameDraft(e.target.value)}
                          placeholder={dev.deviceId}
                          autoFocus
                        />
                        <button
                          type="button"
                          className="grok-done-pill-btn"
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(async () => {
                              const api = await ensureRemoteApi();
                              if (!api || !api.identity) throw new Error('Not connected');
                              await api.broker(api.identity, 'rename_device', {
                                deviceId: dev.deviceId,
                                displayName: renameDraft.trim(),
                              });
                              setRenamingDeviceId(null);
                              onRemoteUpdated();
                            })
                          }
                        >
                          {t('保存', 'Save')}
                        </button>
                        <button
                          type="button"
                          className="hub-outline-btn"
                          onClick={() => setRenamingDeviceId(null)}
                        >
                          {t('取消', 'Cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="grok-row-label" style={{ flex: 1 }}>
                          {dev.displayName || dev.deviceId}
                        </span>
                        <span className={`hub-online-pill${dev.online ? '' : ' is-offline'}`}>
                          {dev.online ? t('在线', 'Online') : t('离线', 'Offline')}
                        </span>
                        <button
                          type="button"
                          className="hub-outline-btn"
                          onClick={() => {
                            setRenamingDeviceId(dev.deviceId);
                            setRenameDraft(dev.displayName || dev.deviceId);
                          }}
                        >
                          {t('改名', 'Rename')}
                        </button>
                      </>
                    )}
                  </div>
                ))}

              </>
            )}
          </section>
          <p className="grok-card-footnote">
            {t(
              '连接远程节点后，远端主机上的 Bot 会自动出现在主页列表中。',
              'Connected remote bots appear directly in your home list.',
            )}
          </p>
        </div>

        {/* Section 3: Local Host Raw JSON */}
        <div className="grok-field-section">
          <label className="grok-section-label">{t('本机底层配置与凭据', 'Local Host Raw Config')}</label>
          <section className="grok-card-group">
            <button type="button" className="grok-card-row" onClick={toggleLocalConfig}>
              <Code2 size={20} className="grok-row-icon" />
              <span className="grok-row-label">{t('高级配置 (JSON)', 'Advanced JSON')}</span>
              <span className="grok-row-value">{showLocalConfig ? t('收起', 'Hide') : t('展开', 'Show')}</span>
              <ChevronRight size={18} className="grok-row-chevron" />
            </button>
          </section>

          {showLocalConfig && (
            <div className="grok-advanced-body" style={{ marginTop: 8 }}>
              <form onSubmit={saveLocalCredentials} className="grok-card-group">
                <label className="grok-card-row grok-input-row">
                  <span className="grok-input-label">{t('凭据 JSON', 'Credentials JSON')}</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="grok-inline-input"
                    value={credJson}
                    onChange={e => setCredJson(e.target.value)}
                    placeholder='{"OPENAI_API_KEY": "sk-..."}'
                  />
                </label>
                <div className="grok-card-row no-active" style={{ justifyContent: 'flex-end' }}>
                  <button type="submit" className="grok-done-pill-btn" disabled={action.busy}>
                    {t('保存凭据', 'Save Credentials')}
                  </button>
                </div>
              </form>

              {hostSettings && (
                <form onSubmit={saveLocalSettings} className="grok-card-group">
                  <div className="grok-card-textarea-wrap">
                    <textarea
                      rows={6}
                      value={settingsJson}
                      onChange={e => setSettingsJson(e.target.value)}
                      spellCheck={false}
                      style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '.82rem' }}
                    />
                  </div>
                  <div className="grok-card-row no-active" style={{ justifyContent: 'flex-end' }}>
                    <button type="submit" className="grok-done-pill-btn" disabled={action.busy}>
                      {t('保存运行配置', 'Save Runtime JSON')}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
        </>}

        <ErrorNotice error={action.error} onDismiss={() => action.setError('')} />
      </div>
    </main>
  );
}
