// HostPage 共享的常量、类型与辅助组件（从 Host.tsx 原样迁出）。
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
} from '../native';
import { mobileLocalRequest, onMobileStreamFailure } from '../native/tauri-host';
import { ActiveCenter, useCenterConnection } from '../native/CenterGate';
import { useDrafts } from '../../../desktop/web/src/drafts';
import { PendingPanel } from '../../../desktop/web/src/PendingPanel';
import { readHistoryPage } from '../../../desktop/web/src/history';
import { Scopes } from '../../../desktop/web/src/Scopes';
import { targetApi } from '../../../desktop/web/src/targetApi';
import type { RoomApiResolver } from '../../../desktop/web/src/scope-api';
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
} from '../gbot-ui';
import { useChatPins } from '../gbot-ui/chatPins';
import { SortablePinnedChat } from '../gbot-ui/SortablePinnedChat';
import type { MessageMember } from '../../../host-core/index.js';
import { createLocalScopeReadApi } from '../local-scope-api';
import { MessageAttribution } from '../MessageAttribution';
import type { DesktopDraftEntry, DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import type { DesktopConnectionInput, DesktopUiProfile } from '../../../host-core/desktop-client.js';
import type { BotLiveState, ClearHistoryResult, CompactResult, DevicesDirectoryItem, PendingCursor, PendingListPage, ScopeInfo, ShowerTarget } from '../../../host-core/index.js';
import type { ShowerCall } from '../ShowerPreview';
import { Markdown } from '../Markdown';
import { BotScreenPanel } from '../BotScreenPanel';
import { BotModelSheet, type BotSettingsTab } from '../BotModelSheet';
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
} from '../GrokBotAvatar';
import { botAvatarKey, saveCentralBotAvatar, syncBotAvatarConfigs } from '../botAvatarSync';
import {
  canStopBotActivity,
  isBotActivityBusy,
  resolveBotActivity,
  type BotActivity,
} from '../botActivity';
import {
  formatTurnDuration,
  latestEntryChannel,
  parseHistoryEntries,
  resolveActiveTurnStartedAt,
  type ChatToolCallItem,
  type ChatTurnBlock,
} from '../chatTurnModel';
import { readToolPresentation } from '../ToolPresentation';
import { ToolCallCard, type ToolCallCardProps } from '../ToolCallCard';
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
} from '../imageAttachments';
import type { ImageAttachment } from '../../../host-core/index.js';
import { ErrorNotice, FloatingPillToast, array, errorText, record, useAction, useText } from '../ui';

export const uuid = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const V5_CLEANUP_KEY = 'bot-hub-v5-cleaned';
export const BOT_META_CACHE_KEY = 'bot-hub-bot-meta-v2';
export const BOT_CLEAR_MAP_KEY = 'bot-hub-cleared-v1';
export const REMOTE_PROFILES_FLAG_KEY = 'bot-hub-has-remote-v1';
export const REMOTE_BOTS_CACHE_KEY = 'bot-hub-remote-bots-cache-v1';
export const REMOTE_DEVICES_CACHE_KEY = 'bot-hub-remote-devices-cache-v1';
export const PRIMARY_ROLE_OVERRIDE_KEY = 'bot-hub-primary-name-v2';
export const DEFAULT_PRIMARY_ROLE = '主助手';
export const CREATE_ATTEMPT_KEY = 'bot-hub-create-attempt-v1';
export const ARCHIVE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

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

export const SOUL_MAX_BYTES = 65536;
export const SOUL_SNIPPETS: { zh: string; en: string; text: string }[] = [
  {
    zh: '＋ 角色使命',
    en: '+ Mission',
    text: '\n# 角色与职责定位\n你是专注本工作区与目标领域的智能体搭档，结合上下文与实证数据直接推进任务并给出可靠结论。\n',
  },
  {
    zh: '＋ 沟通风格',
    en: '+ Style',
    text: '\n# 沟通与表达风格\n- 自然温和、实事求是：像熟悉业务的靠谱搭档交流；已掌握答案或完成核查时第一句直奔结论，需调用工具排查时伴随工具调用简明交代第一步，不在核实前猜测结论，不重复问题、不加客服套话与多余尾注。\n- 篇幅克制、自然段落：日常简明扼要，复杂任务才展开完整细节；优先用连贯自然句表达，仅在真正并列或对比时使用列表与表格。\n',
  },
  {
    zh: '＋ 群聊准则',
    en: '+ Room Rules',
    text: '\n# 多 Bot 协作偏好\n- 发挥自身专长，对可并行或跨设备的子任务积极配合同伴 Bot 分工。\n- 聚焦实质进展与有效结论，其他成员已完整解答或无需补充时保持安静，不发无意义的附和与礼貌回执。\n',
  },
];

export type HubScreen =
  | 'hub'
  | 'board'
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

export interface RoomDeleteAttempt {
  scopeId: string;
  title: string;
  authorityDeviceId: string;
  requestId: string;
  expectedRevision: number;
  sessionKey: string;
  unconfirmed: boolean;
}

export interface RoomDeleteModalState {
  room: ScopeConversation;
  loadingLatest: boolean;
  submitting: boolean;
  attempt: RoomDeleteAttempt | null;
  error: string;
  conflictNeedReload: boolean;
}

export interface BotConfirmModalState {
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

export function normalizePlatformKind(platform?: string): 'android' | 'windows' | 'linux' | 'other' {
  const p = (platform ?? '').toLowerCase();
  if (p.includes('android')) return 'android';
  if (p.includes('win')) return 'windows';
  if (p.includes('linux') || p.includes('ubuntu') || p.includes('debian') || p.includes('arch')) return 'linux';
  return 'other';
}

export function PlatformLogoIcon({ platform, size = 12 }: { platform?: string; size?: number }) {
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

export interface BotPreviewMeta {
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
  /** Explicit skill dependencies; older saved tasks omit this (equivalent to []). */
  skills?: string[];
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

export const WEEKDAY_SHORT_ZH = ['一', '二', '三', '四', '五', '六', '日'];
export const WEEKDAY_SHORT_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatScheduleRepeatLabel(
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

export function formatScheduleNextRun(
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
export interface TurnAdmissionStatus {
  requestId: string;
  phase: 'queued' | 'checking' | 'synchronizing' | 'failed';
  source?: 'primary' | 'background';
  error?: { code: string; message: string };
}
export type TurnAdmissionCarrier = { admission?: TurnAdmissionStatus | null };

export interface ChatPending {
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
export interface ChatPendingEntry { pending: ChatPending; receipt?: HostSubmission & TurnAdmissionCarrier }

export function chatStorageKey(center: string, deviceId: string, botId: string): string {
  return `bot-chat-v1:${JSON.stringify([center, deviceId, botId])}`;
}
export function readChatPending(key: string): ChatPendingEntry | undefined {
  try {
    const entry = JSON.parse(localStorage.getItem(`${key}:pending`) || 'null') as ChatPendingEntry | null;
    if (!entry?.pending?.requestId || entry.pending.scopeKey !== key) return undefined;
    return { ...entry, pending: { ...entry.pending, phase: entry.receipt ? 'accepted' : 'recovering' } };
  } catch { return undefined; }
}
export function readChatDraft(key: string): string {
  try { return localStorage.getItem(`${key}:draft`) || ''; } catch { return ''; }
}
export function writeChatDraft(key: string, text: string): boolean {
  try { if (text) localStorage.setItem(`${key}:draft`, text); else localStorage.removeItem(`${key}:draft`); return true; }
  catch { return false; }
}

/** 本机草稿附件引用只存 ImageAttachment 元数据；base64 绝不进 localStorage/pending。 */
export function readChatDraftAttachments(key: string): ImageAttachment[] {
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

export function writeChatDraftAttachments(key: string, attachments: ImageAttachment[]): boolean {
  try {
    if (attachments.length) localStorage.setItem(`${key}:draft-attachments`, JSON.stringify(attachments));
    else localStorage.removeItem(`${key}:draft-attachments`);
    return true;
  } catch {
    return false;
  }
}

export function readBotMetaMap(): Record<string, BotPreviewMeta> {
  try {
    const raw = window.localStorage.getItem(BOT_META_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, BotPreviewMeta>) : {};
  } catch {
    return {};
  }
}

export function writeBotMetaMap(map: Record<string, BotPreviewMeta>): void {
  try {
    window.localStorage.setItem(BOT_META_CACHE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

export function readClearedMap(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(BOT_CLEAR_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function writeClearedMap(map: Record<string, number>): void {
  try {
    window.localStorage.setItem(BOT_CLEAR_MAP_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

export function readHasRemoteFlag(): boolean {
  try {
    return window.localStorage.getItem(REMOTE_PROFILES_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeHasRemoteFlag(hasRemote: boolean): void {
  try {
    if (hasRemote) window.localStorage.setItem(REMOTE_PROFILES_FLAG_KEY, '1');
    else window.localStorage.removeItem(REMOTE_PROFILES_FLAG_KEY);
  } catch {
    // Ignore storage errors
  }
}

export type CachedRemoteBot = HostBot & { deviceName: string; platform?: string; description?: string };

/** 本机 bot 列表读取的 scope：connectionEpoch+activeCenter 组合，每次变化都换新对象（同值 A→B→A 也是新引用）。 */
export interface LocalBotsScope { key: string; center: string }
export interface LocalBotsFlight { scope: LocalBotsScope; task: Promise<HostBot[]> }

export function readCachedRemoteBots(): CachedRemoteBot[] {
  try {
    const raw = window.localStorage.getItem(REMOTE_BOTS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CachedRemoteBot[]) : [];
  } catch {
    return [];
  }
}

export function writeCachedRemoteBots(bots: CachedRemoteBot[]): void {
  try {
    window.localStorage.setItem(REMOTE_BOTS_CACHE_KEY, JSON.stringify(bots));
  } catch {
    // Ignore storage errors
  }
}

export function readCachedRemoteDevices(): DevicesDirectoryItem[] {
  try {
    const raw = window.localStorage.getItem(REMOTE_DEVICES_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DevicesDirectoryItem[]) : [];
  } catch {
    return [];
  }
}

export function writeCachedRemoteDevices(devices: DevicesDirectoryItem[]): void {
  try {
    window.localStorage.setItem(REMOTE_DEVICES_CACHE_KEY, JSON.stringify(devices));
  } catch {
    // Ignore storage errors
  }
}

export function formatArchivedRemainingDays(archivedAt: string | null | undefined): number {
  if (!archivedAt) return 14;
  const archivedMs = Date.parse(archivedAt);
  if (!Number.isFinite(archivedMs)) return 14;
  const remainingMs = archivedMs + ARCHIVE_RETENTION_MS - Date.now();
  return Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
}

export async function fetchBotHistoryPages(
  fetchPage: (cursor: Record<string, unknown> | null, limit: number, chunked: boolean) => Promise<HostHistoryPage | null>,
): Promise<Array<Record<string, unknown>> | null> {
  const all: Array<Record<string, unknown>> = [];
  let cursor: Record<string, unknown> | null = null;
  for (;;) {
    const page = await readHistoryPage(fetchPage, cursor, 200);
    // fetchPage 返回 null 表示本次读取已失效（scope 切换/请求作废）：丢弃已读部分页，
    // 绝不把半截历史当成完整快照回填。
    if (!page) return null;
    const items = array<Record<string, unknown>>(page.items);
    if (items.length > 0) all.push(...items);
    const next = page.nextCursor;
    if (!next || typeof next !== 'object' || Array.isArray(next) || items.length === 0) break;
    cursor = next as Record<string, unknown>;
  }
  return all;
}

export function mergeHistory(previous: Array<Record<string, unknown>>, next: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const items = new Map(previous.map(item => [String(item.id), item]));
  for (const item of next) items.set(String(item.id), item);
  return [...items.values()];
}

/** 同 scope+同代际的并发全量历史读取共用一个 flight；代际不符不共享（A→B→A、/clear、
    连接代际变化都不复用旧读）。fresh() 在每页边界判废：scope 被更新 flight 顶掉或代际失效
    时返回 null，读随之丢弃已读部分页，绝不回半截数据。 */
export function sharedHistoryRead(
  flights: Map<string, { epoch: number; task: Promise<Array<Record<string, unknown>> | null> }>,
  scopeKey: string,
  epochRef: { current: number },
  current: () => boolean,
  read: (fresh: () => boolean) => Promise<Array<Record<string, unknown>> | null>,
): Promise<Array<Record<string, unknown>> | null> {
  const epoch = epochRef.current;
  const existing = flights.get(scopeKey);
  if (existing && existing.epoch === epoch) return existing.task;
  const rec = { epoch, task: Promise.resolve(null) as Promise<Array<Record<string, unknown>> | null> };
  const fresh = () => epochRef.current === epoch && current() && flights.get(scopeKey) === rec;
  rec.task = Promise.resolve().then(() => read(fresh)).then(items => fresh() ? items : null).finally(() => {
    if (flights.get(scopeKey) === rec) flights.delete(scopeKey);
  });
  flights.set(scopeKey, rec);
  return rec.task;
}

export function maxHistoryEntryId(items: Array<Record<string, unknown>>): number {
  let max = 0;
  for (const item of items) {
    const id = typeof item.id === 'number' ? item.id : Number(item.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max;
}

// 聊天 slash 命令：只有 /clear 与 /compact；执行全部走后端控制方法，不经过模型 submit。
export function formatToolStepDuration(ms: number): string {
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

export function copyTextToClipboard(value: string): void {
  if (!value) return;
  try {
    void navigator.clipboard?.writeText(value);
  } catch {
    // Ignore clipboard permission errors in webview
  }
}

export function renderToolStepIcon(status: ChatToolCallItem['status']) {
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

export function extractSmartArgEntries(
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

export function TurnToolCallsSection({
  tools,
  scopeKey,
  active,
  disabled,
  onSubmitQuestionnaire,
  onSubmitVaultUnlock,
  t,
}: Omit<ToolCallCardProps, 'tool'> & {
  tools: ChatToolCallItem[];
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
          <ToolCallCard
            key={tool.id}
            tool={tool}
            scopeKey={scopeKey}
            active={active}
            disabled={disabled}
            onSubmitQuestionnaire={onSubmitQuestionnaire}
            onSubmitVaultUnlock={onSubmitVaultUnlock}
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
            <ToolCallCard
              key={tool.id}
              tool={tool}
              scopeKey={scopeKey}
              active={active}
              disabled={disabled}
              onSubmitQuestionnaire={onSubmitQuestionnaire}
              onSubmitVaultUnlock={onSubmitVaultUnlock}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const SLASH_COMMANDS = [
  { name: '/clear', zh: '清空当前对话并重置模型上下文', en: 'Clear history and reset model context' },
  { name: '/compact', zh: '压缩较早的上下文', en: 'Compact earlier context' },
] as const;
export type SlashCommandName = (typeof SLASH_COMMANDS)[number]['name'];

export function slashMatches(text: string) {
  return text.startsWith('/') && !/\s/.test(text)
    ? SLASH_COMMANDS.filter(command => command.name.startsWith(text))
    : [];
}

export function parseSlashCommand(text: string): SlashCommandName | undefined {
  const trimmed = text.trim();
  return SLASH_COMMANDS.find(command => command.name === trimmed)?.name;
}

/**
 * 两处输入框共用的 slash 补全：仅整段输入为 / 或命令前缀时出现，按前缀筛选；↑↓ 选择，Tab/点击只补全，
 * Enter 在未完整匹配时补全、已输入完整命令时执行，Esc 隐藏至输入再次变化；Shift+Enter 与 IME 不触发。
 * 补全只写调用方给的现有草稿路径。
 */
export function useSlashAutocomplete({ text, disabled, onText, onRun }: {
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

export const soulBytes = (text: string): number => {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
};

export function parseBotSoul(value: unknown): BotSoul | undefined {
  const raw = record(value);
  return typeof raw.botId === 'string' &&
    typeof raw.path === 'string' &&
    typeof raw.revision === 'string' &&
    typeof raw.text === 'string'
    ? { botId: raw.botId, path: raw.path, revision: raw.revision, text: raw.text }
    : undefined;
}

