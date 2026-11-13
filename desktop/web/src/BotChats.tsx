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
  ChevronRight,
  Clock,
  Cpu,
  FileText,
  History,
  LockKeyhole,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  RefreshCw,
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
import type { DesktopIdentity, DesktopPanelApi } from './types';
import type { DesktopObservationEvent } from './types';
import { ErrorNotice, useText } from '../../../web/src/ui';
import { BotReadScope } from '../../../web/src/botReadScope';
import { deleteBotAndVerify } from '../../../web/src/botOperations';
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
import { readToolPresentation, type QuestionnaireSubmitPayload, type VaultUnlockSubmitPayload } from '../../../web/src/ToolPresentation';
import { GrokBotAvatar } from '../../../web/src/GrokBotAvatar';
import { BotBoard } from '../../../web/src/BotBoard';
import { botBoardKey, useBotBoard, useMarkViewedBoardResult, type BotBoardTarget } from '../../../web/src/useBotBoard';
import {
  botActivityText,
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
import { BotSettings, type BotSettingsTab } from './BotSettings';
import { ShowerPreview } from './ShowerPreview';
import { ChatTranscript } from './ChatTranscript';
import type { ChatTurn, KnownBotSummary } from '../../../web/src/chatTurnModel';
import {
  extractEditableUserText,
  mergeQueuedStripItems,
  resolveAttachmentMetasByIds,
  type UnifiedQueuedStripItem,
} from '../../../web/src/composerFlowControl';
import { ComposerEditBanner, PendingQueueStrip } from '../../../web/src/ComposerFlowStrips';
import { BotAvatarStudio } from './BotAvatarStudio';
import { targetApi } from './targetApi';
import { readHistoryPage } from './history';
import { Scopes } from './Scopes';
import { invoke } from '@tauri-apps/api/core';
import type { RoomApiResolver, ScopeReadApi } from './scope-api';
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
import './BotChats.css';

type AnyRawEntry = { id: unknown; kind: string; model?: unknown; data?: unknown };

const ARCHIVE_RETENTION_DAYS = 14;
/** 与 BotChats.css 并排断点一致：≥1280px 抽屉并排非模态，<1280px 浮层模态。 */
const INSPECTOR_COMPACT_QUERY = '(max-width: 1279px)';

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
  openConversation: (target: SendRecordsTarget) => void;
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
    'pi.assistant': '智能体回复',
    'pi.tool_result': '工具结果',
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
}: {
  api: DesktopPanelApi;
  devices: DevicesDirectoryItem[];
  bots: BotDirectoryEntry[];
  initialDeviceId?: string;
  onCreated: (deviceId: string, bot: BotRecord) => void;
}) {
  const [deviceId, setDeviceId] = useState(initialDeviceId);
  const [role, setRole] = useState('');
  const [description, setDescription] = useState('');
  const [cwd, setCwd] = useState('');
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
      setError('请输入智能体名称。');
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
      setRole('');
      setDescription('');
      setCwd('');
      onCreated(deviceId, effectiveMakePrimary ? { ...bot, isPrimary: true } : bot);
    } catch (e) {
      if (!mountedRef.current) return;
      if (
        !isNotSent(e) &&
        !(e && typeof e === 'object' && (e as { outcome?: string }).outcome === 'responded')
      ) {
        setLocked(true);
      }
      setError(
        `${errText(e)}（原 requestId: ${requestId}；可在发送记录里核对结果）`,
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
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        名称
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={busy || locked}
          autoFocus
        />
      </label>
      <label className="field">
        职责（可选）
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          disabled={busy || locked}
        />
      </label>
      <p className="hint">{deviceId ? `创建于 ${devices.find(device => device.deviceId === deviceId)?.displayName || '所选设备'}` : '请在高级设置中选择在线设备。'}</p>
      {forcePrimary ? (
        <p className="hint">该设备当前没有主智能体，创建后会自动设为主智能体。</p>
      ) : null}
      <details className="bot-form-advanced">
        <summary>高级设置</summary>
        <div className="form-grid">
          <label className="field">
            目标设备
            <select value={deviceId} onChange={(e) => handleSelectDevice(e.target.value)} disabled={busy || locked}>
              <option value="">请选择设备</option>
              {devices.map(device => (
                <option key={device.deviceId} value={device.deviceId} disabled={!device.online}>
                  {device.displayName || '未命名设备'}{device.online ? '' : ' · 离线'}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            工作目录（可选）
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} disabled={busy || locked} placeholder="留空使用设备默认工作目录" />
          </label>
          {targetHasPrimary ? (
            <label className="field checkbox-field">
              <input type="checkbox" checked={makePrimary} disabled={busy || locked} onChange={(e) => setMakePrimary(e.target.checked)} />
              <span>替换该设备的主智能体</span>
            </label>
          ) : null}
        </div>
      </details>
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="primary-button" disabled={busy || locked || !api.transportConnected}>
          {busy ? '创建中…' : '创建智能体'}
        </button>
      </div>
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

function Composer({ textareaRef, text, onChangeText, files, onAddFile, onRemoveFile, attachments, onAddAttachment, onRemoveAttachment, attachmentFetcher, onPickImage, canPick, onPick, draftError, draftHint, draftConflict, sendState, receiptBusy, sendError, sendNotice, onSend, canSend, disabled, isPreLlm, isLlmRunning, isStopping, canStop, stopDisabled, onStop, stopButtonRef, onRetryDraft, attempt, recOutcome, onReleaseNotSent, onRetryClearVerified, onAdoptNewerDraft, turnAdmission, onRetryTurnAdmission, onInsertSlash, onOpenSendRecord, queuedItems, queueBusy, onRecallQueued, onRecallAllQueued, onDiscardQueued, onSteerQueued, isEditingTurn = false, onCancelEditTurn }: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onChangeText: (v: string) => void;
  files: { name: string; path: string; size: number }[];
  onAddFile: (ref: { name: string; path: string; size: number }) => void;
  onRemoveFile: (i: number) => void;
  attachments: ImageAttachment[];
  onAddAttachment: (att: ImageAttachment) => void;
  onRemoveAttachment: (i: number) => void;
  attachmentFetcher: AttachmentFetcher | null;
  onPickImage: () => void;
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
  /** 最新可见的 Host 准入状态（来自原 pending 记录 receipt.admission）；null 表示无等待项。 */
  turnAdmission: TurnAdmissionView | null;
  /** Host 准入失败后的显式重试：沿用冻结的同一 requestId/文本重新入队，不自动重发。 */
  onRetryTurnAdmission: () => void;
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
}) {
  const [slashIndex, setSlashIndex] = useState(0);
  const [dismissedSlash, setDismissedSlash] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      if (moreRef.current && e.target instanceof Node && !moreRef.current.contains(e.target)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

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
        onSend(isLlmRunning && !isEditingTurn ? 'steer' : 'followUp');
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
      : isLlmRunning
        ? 'Enter 排队 · Ctrl+Enter 立即插入 · Shift+Enter 换行'
        : 'Enter 发送 · Shift+Enter 换行 · / 呼出命令');
  const footerRecordAction = sendState === 'idle' && sendNotice?.showRecordAction &&
    !recoveringAttempt && !sendError
    ? onOpenSendRecord
    : undefined;
  const hasDraftContent = text.trim().length > 0 || attachments.length > 0;

  return (
    <div className="composer bot-composer">
      <div className="composer-extras">
        {draftError ? (
          <ErrorNotice error={draftError} actionLabel="重试保存" onAction={onRetryDraft} compact />
        ) : null}
        {draftConflict ? (
          <div className="status">
            <span>
              磁盘上的新版草稿：{truncate(draftConflict.text, 160) || '（空文本）'}
              {draftConflict.files.length > 0 ? `（${draftConflict.files.length} 个文件引用）` : ''}
            </span>
          </div>
        ) : null}
        {recoveringAttempt ? (
          <div className="error-banner" role="alert">
            {recoveringAttempt.phase === 'not-sent' ? (
              <>
                <span className="error-banner-text">{sendError ?? recoveringAttempt.error ?? '消息尚未入队。'}</span>
                <button type="button" onClick={onReleaseNotSent}>恢复编辑</button>
              </>
            ) : (
              <>
                <span className="error-banner-text">{sendError ?? recoveringAttempt.error ?? '草稿需要处理。'}</span>
                {onOpenSendRecord ? <button type="button" onClick={onOpenSendRecord}>查看发送记录</button> : null}
                {draftConflict && recOutcome?.found ? (
                  <button type="button" onClick={onAdoptNewerDraft}>保留新版草稿，结束旧尝试</button>
                ) : null}
                {recOutcome?.action === 'ready-clear-retry' ? (
                  <button type="button" onClick={onRetryClearVerified}>重试本地清空</button>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        {turnAdmission?.phase === 'failed' ? (
          <ErrorNotice title="消息暂未开始处理" description="内容已保留，可以重试。"
            detail={turnAdmission.error ? `${turnAdmission.error.code}: ${turnAdmission.error.message ?? ''}` : undefined}
            actionLabel="重试发送" onAction={onRetryTurnAdmission} compact />
        ) : null}
        {sendError && !attempt ? (
          <ErrorNotice error={sendError} actionLabel={onOpenSendRecord ? '查看发送记录' : undefined} onAction={onOpenSendRecord} compact />
        ) : null}
        {files.length > 0 ? (
          <>
            <p className="hint">已引用 {files.length} 个路径，发送时按原文引用，不会上传文件。</p>
            <div className="file-refs">
              {files.map((f, i) => (
                <span key={`${f.path}#${i}`} className="file-ref" title={f.path}>
                  <FileText size={12} aria-hidden="true" />
                  {f.name} · {f.size} B
                  <button type="button" onClick={() => onRemoveFile(i)} disabled={disabled} aria-label={`移除 ${f.name}`}>
                    <X size={12} />
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
      {isEditingTurn && onCancelEditTurn ? (
        <ComposerEditBanner
          disabled={disabled || receiptBusy}
          onCancel={onCancelEditTurn}
        />
      ) : queuedItems && queuedItems.length > 0 && onRecallQueued && onRecallAllQueued && onDiscardQueued ? (
        <PendingQueueStrip
          items={queuedItems}
          disabled={Boolean(queueBusy || disabled || isStopping)}
          onRecall={onRecallQueued}
          onRecallAll={onRecallAllQueued}
          onDiscard={onDiscardQueued}
          onSteer={onSteerQueued}
        />
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
          <div ref={moreRef}>
            <button
              type="button"
              className="icon-button composer-plus"
              disabled={disabled}
              aria-label="添加附件"
              title="添加附件"
              onClick={() => setMoreOpen((v) => !v)}
            >
              <Plus size={18} />
            </button>
            {moreOpen ? (
              <div className="composer-plus-menu" role="menu">
                {canPick ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      onPick();
                    }}
                  >
                    <FileText size={14} /> 添加本地路径引用
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  disabled={disabled || attachments.length >= IMAGE_MAX_COUNT}
                  onClick={() => {
                    setMoreOpen(false);
                    onPickImage();
                  }}
                >
                  <FileText size={14} /> 添加图片
                </button>
                {!canPick && !isEditingTurn ? (
                  <p className="composer-plus-note" role="note">
                    Relay 模式不可选本机文件；可将目标 Host 上已存在的路径作为普通文本引用。
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          <textarea
            ref={textareaRef}
            className="composer-input"
            value={text}
            onChange={(e) => onChangeText(e.target.value)}
            onKeyDown={onKeyDown}
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
              <RefreshCw size={15} className="grok-spin" />
            </button>
          ) : isPreLlm || receiptBusy ? (
            <button
              type="button"
              className="composer-loading"
              disabled
              aria-busy={true}
              aria-label="处理中…"
              title="前置准备中…"
            >
              <SendButtonIcon busy={true} size={16} />
            </button>
          ) : isLlmRunning ? (
            <>
              {hasDraftContent && !isEditingTurn ? (
                <button
                  type="button"
                  className="composer-steer"
                  onClick={() => onSend('steer')}
                  disabled={receiptBusy || disabled || !canSend || isPreLlm || isStopping}
                  aria-label="打断并立即发送"
                  title="打断并立即发送 (Ctrl+Enter)"
                >
                  <Zap size={14} />
                </button>
              ) : null}
              {hasDraftContent || !canStop ? (
                <button
                  type="button"
                  className="composer-send primary-button"
                  onClick={() => onSend('followUp')}
                  disabled={receiptBusy || disabled || !canSend || isPreLlm || isStopping}
                  aria-label="排队发送"
                  title="Enter 排队发送 · Ctrl+Enter 立即插入"
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
              aria-label="停止此智能体"
              title="停止当前执行并将排队消息撤回输入框"
            >
              <Square size={14} />
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
  const [name, setName] = useState(bot.role);
  const [description, setDescription] = useState(bot.description ?? '');
  const [cwd, setCwd] = useState(bot.cwd);
  const [cwdRevision, setCwdRevision] = useState<number | null>(null);
  const [cwdFailed, setCwdFailed] = useState(false);
  const [cwdNotice, setCwdNotice] = useState<string | null>(null);
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [cwdOpened, setCwdOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
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
      if (cwdFetchRef.current !== fetchId) return;
      setCwdRevision(config.revision);
      setCwdFailed(false);
      setCwdError(null);
      if (!cwdDirty.current) setCwd(config.value ?? bot.cwd);
      cwdBaseline.current = config.value ?? bot.cwd;
    } catch {
      if (cwdFetchRef.current !== fetchId) return;
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
    if (!identity || !api.transportConnected || inFlight.current || locked || isArchived) return;
    if (!name.trim()) { setError('Bot 名称必填'); return; }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.call(identity, 'updateBotProfile', { botId: bot.botId, name: name.trim(), description: description.trim() });
      if (sessionKey(api.identity) !== sessionKey(identity)) return;
      dirty.current = false;
      setName(updated.role);
      setDescription(updated.description ?? '');
      onSaved(updated);
    } catch (e) {
      if (sessionKey(api.identity) !== sessionKey(identity)) return;
      if (!isNotSent(e) && !(e && typeof e === 'object' && (e as { outcome?: string }).outcome === 'responded')) setLocked(true);
      setError(`资料保存失败：${errText(e)}。结果未确认时请读取并采用远端资料核对，不会自动重发。`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function adoptRemote() {
    const identity = api.identity;
    if (!identity || !api.transportConnected || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const items = await api.call(identity, 'listBots', {});
      if (sessionKey(api.identity) !== sessionKey(identity)) return;
      const fresh = items.find((item) => item.botId === bot.botId);
      if (!fresh) { setError('远端没有此 Bot；保留草稿与锁定。'); return; }
      dirty.current = false;
      setName(fresh.role);
      setDescription(fresh.description ?? '');
      setLocked(false);
      setError(null);
      onSaved(fresh);
    } catch (e) {
      if (sessionKey(api.identity) === sessionKey(identity)) setError(`读取远端资料失败：${errText(e)}；保留草稿与锁定。`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const trimmedCwd = cwd.trim();
  const cwdChanged = trimmedCwd !== cwdBaseline.current && trimmedCwd !== '';
  const cwdSavable = cwdChanged && cwdRevision !== null;

  async function saveCwd() {
    const identity = centerApi.identity;
    if (!identity || !centerOnline || inFlight.current || isArchived || !cwdSavable) return;
    inFlight.current = true;
    cwdFetchRef.current += 1;
    setBusy(true);
    setCwdError(null);
    setCwdNotice(null);
    try {
      const config = await centerApi.broker(identity, 'center_bot_cwd_set', {
        deviceId: bot.deviceId,
        botId: bot.botId,
        expectedRevision: cwdRevision,
        value: trimmedCwd,
      });
      if (sessionKey(centerApi.identity) !== sessionKey(identity)) return;
      setCwdRevision(config.revision);
      cwdDirty.current = false;
      cwdBaseline.current = config.value ?? trimmedCwd;
      setCwd(config.value ?? trimmedCwd);
      setCwdNotice('已保存到中心；目标 Host 空闲后生效，运行中的任务保持原目录，不会移动文件。');
      onSaved({ ...bot, cwd: config.value ?? trimmedCwd });
    } catch (e) {
      if (sessionKey(centerApi.identity) !== sessionKey(identity)) return;
      const code = (e as { code?: string })?.code;
      if (code === 'REVISION_CONFLICT' || code === 'REQUEST_CONFLICT') {
        setCwdRevision(null);
        setCwdError('工作目录已被其他修改占用；请重新读取后再保存。');
      } else {
        setCwdError('工作目录保存失败：' + errText(e));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (page === 'management') return (
    <div className="form-grid inspector-profile-form">
      <label className="field">
        工作目录
        <input
          value={cwd}
          disabled={busy || isArchived}
          placeholder="目标设备上的绝对路径"
          onChange={(e) => { cwdDirty.current = true; setCwd(e.target.value); setCwdNotice(null); }}
        />
      </label>
      <p className="hint">保存后将在智能体空闲时生效。</p>
      {cwdNotice ? <div className="status" role="status">{cwdNotice}</div> : null}
      {cwdError || cwdFailed ? <div className="error-banner" role="alert">{cwdError ?? '无法读取工作目录。'}</div> : null}
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={() => void saveCwd()} disabled={busy || isArchived || !centerOnline || !cwdSavable}>保存工作目录</button>
        {(cwdFailed || (cwdError && cwdRevision === null)) ? (
          <button type="button" className="secondary-button" disabled={busy || !centerOnline} onClick={() => void loadCwdRef.current()}>重新读取工作目录</button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="form-grid inspector-profile-form">
      <label className="field">名称<input value={name} maxLength={120} disabled={busy || locked || isArchived} onChange={(e) => { dirty.current = true; setName(e.target.value); }} /></label>
      <label className="field">职责<textarea value={description} maxLength={2000} disabled={busy || locked || isArchived} onChange={(e) => { dirty.current = true; setDescription(e.target.value); }} /></label>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      <div className="form-actions">
        {locked ? (
          <button type="button" className="secondary-button" disabled={busy || !api.transportConnected} onClick={() => void adoptRemote()}>读取并采用远端资料（丢弃草稿）</button>
        ) : null}
        <button type="button" className="primary-button" onClick={() => void save()} disabled={busy || locked || isArchived || !api.transportConnected}>保存资料</button>
      </div>
    </div>
  );
}

type InspectorDetail = BotSettingsTab | 'management';
type InspectorTab = 'profile' | InspectorDetail | 'raw' | 'shower';

interface InspectorPage {
  id: InspectorDetail;
  label: string;
  Icon: LucideIcon;
}

const inspectorGroups: ReadonlyArray<{ title: string; pages: readonly InspectorPage[] }> = [
  { title: '常用设置', pages: [
    { id: 'model', label: '模型', Icon: Cpu },
    { id: 'soul', label: '人设', Icon: FileText },
    { id: 'capabilities', label: '插件与能力', Icon: Puzzle },
    { id: 'schedules', label: '定时任务', Icon: Clock },
  ] },
  { title: '更多', pages: [
    { id: 'skill-review', label: '已学技能', Icon: Sparkles },
    { id: 'vault', label: '密码库', Icon: LockKeyhole },
    { id: 'management', label: '管理', Icon: Settings },
  ] },
];
const inspectorPages = inspectorGroups.flatMap(group => group.pages);

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
  onRequestArchive,
  focusComposer = false,
  inspectorRequest = null,
  questionnaireRequestId,
  onQuestionnaireFocused,
  transcriptVisible = true,
  centerInterrupted = false,
  pageActive = true,
  knownBots,
}: {
  api: DesktopPanelApi;
  /** 未按目标在线收窄的原 api：仅中心权威操作（cwd get/set）使用。 */
  centerApi: DesktopPanelApi;
  bot: BotRecord;
  readScope: BotReadScope;
  /** 目录侧设备显示名（仅展示）。 */
  deviceName: string;
  /** 目录侧设备平台徽标（DevicesDirectoryItem.platform）；BotRecord 无此字段，缺省回退 host。 */
  devicePlatform?: string;
  onProfileSaved: (bot: BotRecord) => void;
  onBotUpdated: (patch: Partial<BotRecord> & { botId: string }) => void;
  onBotDeleted: (botId: string) => void;
  onLiveActivity?: () => void;
  /** 打开该 Bot 参与的私聊列表（只读，默认不选对话）。 */
  onOpenPrivateChats?: (bot: BotRecord) => void;
  onOpenSendRecords?: (target: SendRecordsTarget) => void;
  onRequestArchive: () => void;
  focusComposer?: boolean;
  inspectorRequest?: { tab: InspectorTab; seq: number } | null;
  questionnaireRequestId?: string;
  onQuestionnaireFocused?: (id: string) => void;
  transcriptVisible?: boolean;
  centerInterrupted?: boolean;
  pageActive?: boolean;
  knownBots?: readonly KnownBotSummary[];
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
  const [chatSearch, setChatSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const autoFocusedRef = useRef(false);
  /** 本聊天最新的 Host 准入状态（Host-queued 回执中的 admission）；null 表示无等待项。 */
  const [turnAdmission, setTurnAdmission] = useState<TurnAdmissionView | null>(null);
  /** 抽屉 Portal 容器：紧凑模态只锁本聊天气泡层，不影响左栏名录与导航。 */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const inspectorContentRef = useRef<HTMLDivElement | null>(null);
  const inspectorBodyRef = useRef<HTMLDivElement | null>(null);
  const inspectorTitleRef = useRef<HTMLHeadingElement | null>(null);
  const previousInspectorTabRef = useRef<InspectorTab | null>(null);
  const profileScrollRef = useRef(0);

  const [manageAction, setManageAction] = useState<'setPrimary' | 'unarchive' | 'delete' | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteConfirmationRef = useRef<HTMLDivElement | null>(null);
  const manageDeleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const manageInFlightRef = useRef(false);
  const manageBusy = manageAction !== null;

  const onLiveActivityRef = useRef(onLiveActivity);
  onLiveActivityRef.current = onLiveActivity;

  /** 问卷提交复用现有 callCapabilityAction；deviceId/botId 取自当前身份与 Bot。 */
  const submitQuestionnaire = useCallback(
    (installationId: string, input: QuestionnaireSubmitPayload): Promise<unknown> => {
      const current = api.identity;
      if (!current || !api.transportConnected) {
        return Promise.reject(new Error('NOT_CONNECTED: 没有活动连接身份'));
      }
      return api.call(current, 'callCapabilityAction', {
        installationId,
        action: 'answerQuestionnaire',
        request: {
          requestId: crypto.randomUUID(),
          deviceId: current.targetDeviceId,
          botId: bot.botId,
          input,
        },
      });
    },
    [api, bot.botId],
  );

  // 私有解锁回执绑定当前目标身份，不经过聊天提交或离线待发队列。
  const submitVaultUnlock = useCallback((input: VaultUnlockSubmitPayload): Promise<unknown> => {
    const current = api.identity;
    if (!identity || !current || !api.transportConnected ||
      current.profileId !== identity.profileId || current.targetDeviceId !== identity.targetDeviceId ||
      current.kind !== identity.kind || current.generation !== identity.generation) {
      return Promise.reject({ code: 'NOT_CONNECTED' });
    }
    return api.call(identity, 'vaultControl', { action: 'respondUnlock', ...input });
  }, [api, identity]);
  const toolScopeKey = JSON.stringify([
    identity?.profileId, identity?.targetDeviceId, identity?.kind, identity?.generation,
    bot.botId, bot.primaryConversationId, online,
  ]);

  useEffect(() => {
    setManageError(null);
    setConfirmDelete(false);
  }, [bot.botId]);

  const lastInspectorSeqRef = useRef(0);
  useEffect(() => {
    if (inspectorRequest && inspectorRequest.seq !== lastInspectorSeqRef.current) {
      lastInspectorSeqRef.current = inspectorRequest.seq;
      setInspectorTab(inspectorRequest.tab);
    }
  }, [inspectorRequest]);

  useLayoutEffect(() => {
    const previous = previousInspectorTabRef.current;
    previousInspectorTabRef.current = inspectorTab;
    if (previous === 'management' && inspectorTab !== previous) setConfirmDelete(false);
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

  useLayoutEffect(() => {
    if (confirmDelete && inspectorTab === 'management') deleteConfirmationRef.current?.focus();
  }, [confirmDelete, inspectorTab]);

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

  function addAttachment(att: ImageAttachment) {
    if (activeEditing) {
      setEditingTurn((cur) => {
        if (!cur || cur.sess !== sess || cur.botId !== bot.botId) return cur;
        if (cur.attachments.some((a) => a.id === att.id) || cur.attachments.length >= IMAGE_MAX_COUNT) {
          return cur;
        }
        return { ...cur, attachments: [...cur.attachments, { ...att }] };
      });
      return;
    }
    drafts.addAttachment(att);
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
      api.reportError(e);
      setSendError('选择文件失败：' + errText(e));
    }
  }

  const [imageUploadSession, setImageUploadSession] = useState<string | null>(null);
  const imageUploading = imageUploadSession === sess;

  /** 桌面只选图（无原生相机）；上传归属冻结在发起时的 identity/botId/draftKey（或编辑态 entryId）。
   *  addAttachment 的 expectedKey 是原子 guard（useDrafts 内部 keyRef 实时比较）：
   *  切换 Bot/身份后未完成批次中止，已上传结果不写新 scope 草稿。
   *  相同图片 id 去重；去重后总数 ≤4，超限整体拒绝保留原草稿。 */
  function pickImage() {
    const frozenIdentity = identity;
    const frozenEditEntryId = activeEditing?.entryId ?? null;
    const draftKey = drafts.key;
    if (!frozenIdentity || lockedRef.current || isArchived || imageUploading) return;
    if (frozenEditEntryId === null && !draftKey) return;
    const baseAttachments = activeEditing ? activeEditing.attachments : drafts.attachments;
    setImageUploadSession(sess);
    pickImagesFromInput({
      onPicked: async (files) => {
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
          api.reportError(e);
          setSendError('选择图片失败：' + errText(e));
        }
      },
      onSettled: () => {
        if (mountedRef.current) setImageUploadSession(current => current === sess ? null : current);
      },
    });
  }

  const [observedLive, setObservedLive] = useState<{ session: string; state: BotLiveState } | null>(null);
  const live = observedLive && (!online || observedLive.session === sess) ? observedLive.state : null;
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
    if (!current || !draftKey) return;
    lockedRef.current = true;
    setSlashBusy(command);
    setSendState('sending');
    setSendError(null);
    setSendNotice({ text: command === '/clear' ? '正在清空对话…' : '正在压缩上下文…' });
    try {
      const result = await api.call(current, command === '/clear' ? 'clearHistory' : 'compact', { botId: bot.botId });
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      // 服务端已成功后才清命令草稿：沿用 clearDraft CAS，仅当持久草稿仍是该命令文本且无文件
      // 引用时清空；等待期间写入的新文本保留（与手机端 runSlashCommand 同约定）。
      const persisted = api.snapshot?.state.drafts[draftKey];
      if (persisted && persisted.text === draftText && persisted.files.length === 0) {
        try {
          await api.clearDraft(draftKey, [{ text: draftText, files: [] }]);
          if (isCurrentSession() && drafts.text === draftText) drafts.editText('');
        } catch {
          // CAS 冲突/写失败：持久草稿保留，不掩盖服务端已成功的事实。
        }
      } else if (drafts.text === draftText) {
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
      setSendError(command + ' 失败：' + tErr(e) + '；草稿与历史保留，不会当普通消息发送。');
      reportUnlessTargetOffline(api, e);
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
    if (
      stopping ||
      Boolean(live?.busy) ||
      (live?.queuedCount ?? 0) > 0 ||
      isBotActivityBusy(curActivity) ||
      (turnAdmission !== null && turnAdmission.phase !== 'failed')
    ) {
      setSendError('智能体忙碌时无法编辑历史消息，草稿已保留，请稍后重试或按 Esc 取消。');
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
      setTurnAdmission(nextAdmission);
      void loadRawLatest();
      onLiveActivityRef.current?.();
    } catch (e) {
      if (!isCurrentSession()) return;
      if (toError(e).code === 'RUNTIME_BUSY') {
        setSendError('智能体忙碌时无法编辑历史消息，草稿已保留，请稍后重试或按 Esc 取消。');
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
      if (
        stopping ||
        curActivity.phase === 'stopping' ||
        (!isBotLlmRunningPhase(curActivity.phase) &&
          (isBotPreLlmPhase(curActivity.phase) ||
            (turnAdmission !== null && turnAdmission.phase !== 'failed')))
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
      if (live?.busy || drafts.attempt || drafts.savePaused || drafts.files.length > 0) {
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
    const composed = filesNow.length
      ? msg + '\n' + filesNow.map((f) => `[文件路径引用，未上传] ${f.path}`).join('\n')
      : msg;
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
      setSendError('设备未接收消息。详情见发送记录。');
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

  /** 找到本 Bot 最近一条 Host-queued 记录（本地分页，只读；返回 null 表示无等待项）。 */
  async function findHostAdmissionRecord(): Promise<PendingRecord | null> {
    const current = api.identity;
    if (!current) return null;
    let cursor: PendingCursor | null = null;
    for (let pageNo = 0; pageNo < 20; pageNo += 1) {
      const page: PendingListPage = await api.pending(current, 'pending_list', { options: { limit: 50, cursor } });
      const hit = page.items.find(
        (item: PendingRecord) => item.kind === 'primary' && item.botId === bot.botId && readHostQueuedReceipt(item) !== null,
      );
      if (hit) return hit;
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return null;
  }

  /** 显式刷新 Host 准入状态；找不到等待记录即清空显示。 */
  async function refreshTurnAdmission() {
    try {
      const rec = await findHostAdmissionRecord();
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
    const rec = await findHostAdmissionRecord();
    if (!isCurrentSession()) return;
    const admission = rec ? readHostQueuedReceipt(rec)?.admission ?? null : null;
    if (!rec || rec.kind !== 'primary' || !admission || admission.phase !== 'failed') {
      if (mountedRef.current) setTurnAdmission(admission);
      return;
    }
    lockedRef.current = true;
    setSendState('sending');
    setSendError(null);
    try {
      const receipt = await api.call(current, 'submit', {
        botId: rec.botId,
        requestId: rec.requestId,
        text: rec.text,
        ...(rec.attachments?.length ? { attachments: rec.attachments } : {}),
        ...(rec.delivery ? { delivery: rec.delivery } : {}),
      });
      if (!isCurrentSession()) return;
      const nextAdmission = readTurnAdmission((receipt as { admission?: unknown }).admission);
      setTurnAdmission(nextAdmission);
      // 本地 outbox 记录 receipt 仍带旧 admission：显式对账刷新一次（只读，不改远端状态）。
      try { await api.pending(current, 'pending_reconcile', { id: rec.id }); } catch { /* 对账失败不掩盖重试结果 */ }
    } catch (e) {
      if (!isCurrentSession()) return;
      reportUnlessTargetOffline(api, e);
      setSendError('准入重试未确认：' + tErr(e) + '。原 requestId 与记录保留，可再次显式重试，不会自动补发。');
    } finally {
      lockedRef.current = false;
      setSendState('idle');
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
      for (;;) {
        const page: Awaited<ReturnType<typeof readHistoryPage<AnyRawEntry>>> = await readHistoryPage<AnyRawEntry>(async (c, limit, chunked) => {
          if (!isCurrentSession()) return null;
          return api.call(identity, 'history', { botId: bot.botId, limit, cursor: c, ...(chunked ? { chunked: true } : {}) });
        }, cursor, 200);
        if (!page || !isCurrentSession()) return;
        const items = page.items;
        if (items.length === 0) break;
        all.push(...items);
        if (!page.nextCursor || typeof page.nextCursor !== 'object' || Array.isArray(page.nextCursor)) break;
        cursor = page.nextCursor;
      }
      if (!isCurrentSession()) return;
      // 完整可见历史整体替换：/clear 后 reset 之前的条目不再回归，不再依赖截断的 live 窗口。
      setRawItems(all);
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
  }, [api, bot.botId, identity, isCurrentSession, sess]);

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
            setObservedLive({ session: localSess, state: f.state });
            // 快照帧可能带整字段 turnAdmission；缺省/形状非法一律清空显示。
            setTurnAdmission(readTurnAdmission((f.state as { turnAdmission?: unknown }).turnAdmission));
            onLiveActivityRef.current?.();
          } else {
            const changes = (f as { changes?: Partial<BotLiveState> }).changes;
            if (changes && 'turnAdmission' in changes) {
              setTurnAdmission(readTurnAdmission((changes as { turnAdmission?: unknown }).turnAdmission));
            }
            if (changes) {
              setObservedLive(prev => prev?.session === localSess
                ? { session: localSess, state: { ...prev.state, ...changes } }
                : prev);
              if ('history' in changes || 'busy' in changes || 'generation' in changes) {
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
  }, [api, sess, bot.botId, watchTick, online, pageActive, loadRawLatest, isCurrentSession]);

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
    if (!identity || !online || queueBusy || item.source !== 'host') return;
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

  // Ctrl+F 会话内搜索 / Ctrl+. 工作台 由 BotChats 顶层 window 快捷键转发到此。
  useEffect(() => {
    function onSearch() {
      setSearchOpen(true);
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    }
    function onInspector() {
      setInspectorTab((cur) => (cur ? null : 'profile'));
    }
    window.addEventListener('botchats:chat-search', onSearch);
    window.addEventListener('botchats:toggle-inspector', onInspector);
    return () => {
      window.removeEventListener('botchats:chat-search', onSearch);
      window.removeEventListener('botchats:toggle-inspector', onInspector);
    };
  }, []);

  /**
   * 浮层工作台 Esc 关闭（bubble 阶段，不在 document capture 拦截）：
   * - Shower 全窗口剧场/接管中的 Esc 必须发往远端，其 Content 自行处理，这里按 Esc 事件源跳过；
   * - Radix 模态对话框（新建 Bot、设置弹窗等 portal 层）先消费自己的 Esc，这里不截获子控件；
   * - 其余落在抽屉外（遮罩/聊天区）的 Esc 才关闭紧凑浮层；普通宽屏并排不拦截。
   */
  useEffect(() => {
    if (!inspectorTab || !compactOverlay) return;
    function onEsc(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-shower-overlay]')) return;
      setInspectorTab(null);
    }
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [inspectorTab, compactOverlay]);

  // 点击其它区域关闭「更多」菜单
  useEffect(() => {
    if (!moreMenuOpen) return;
    function onDocDown(e: MouseEvent) {
      if (moreMenuRef.current && e.target instanceof Node && !moreMenuRef.current.contains(e.target)) {
        setMoreMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [moreMenuOpen]);

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

  // 正文从 Host 受理起显示任务活动。顶部仍用本地 queued 投影维持发送期间的状态和停止入口。
  const liveActivity = resolveBotActivity(live);
  const transcriptActivity: BotActivity =
    stopping && liveActivity.phase !== 'stopping' && liveActivity.phase !== 'interrupting'
      ? { ...liveActivity, phase: 'stopping' }
      : liveActivity;
  const activity: BotActivity =
    sendState === 'sending' &&
    slashBusy === null &&
    (transcriptActivity.phase === 'idle' || transcriptActivity.phase === 'stopped')
      ? {
          phase: 'queued', source: 'primary', scopeId: null, requestId: null, startedAt: null,
          webhookStopPending: liveActivity.webhookStopPending,
        }
      : transcriptActivity;
  const liveBusy = isBotActivityBusy(activity);
  const canStop = canStopBotActivity(activity);
  const pendingQuestionnaire = online && !isArchived && live?.busy && !liveEnded && !liveError &&
    activity.source !== 'room' && activity.source !== 'dm' && activity.phase !== 'stopping' && activity.phase !== 'interrupting'
    ? readToolPresentation(live.tools?.find(tool => tool.status === 'running' &&
        tool.presentation?.kind === 'questionnaire' && tool.presentation.status === 'pending')?.presentation)
    : null;
  const awaitingAnswer = pendingQuestionnaire?.kind === 'questionnaire'
    ? `等待你确认 · ${pendingQuestionnaire.questions.length} 题` : null;
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
    (turnAdmission !== null && turnAdmission.phase !== 'failed');
  const canEditTurns = Boolean(online && !isArchived && !isBusyForEdit && !editSubmitting && !disabled);
  useEffect(() => {
    if (!editingTurn || editSubmitting) return;
    if (
      editingTurn.sess !== sess ||
      editingTurn.botId !== bot.botId ||
      !online ||
      isArchived
    ) {
      setEditingTurn(null);
    }
  }, [editingTurn, editSubmitting, sess, bot.botId, online, isArchived]);
  const startEditTurn = useCallback(
    (turn: ChatTurn) => {
      if (!canEditTurns) return;
      setSendError(null);
      setSendNotice(null);
      setEditingTurn({
        sess,
        botId: bot.botId,
        entryId: turn.entryId,
        text: extractEditableUserText(turn.text ?? ''),
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
  const queuedStripItems = useMemo(
    () => mergeQueuedStripItems(live?.queuedItems, outboxPendingItems, bot.botId, identity?.targetDeviceId),
    [live?.queuedItems, outboxPendingItems, bot.botId, identity?.targetDeviceId],
  );
  const composerText = activeEditing ? activeEditing.text : drafts.text;
  const composerAttachments = activeEditing ? activeEditing.attachments : drafts.attachments;
  const composerFiles = activeEditing ? [] : drafts.files;
  const desktopComposerAction = resolveComposerActionKind({
    phase: liveActivity.phase,
    online,
    archived: isArchived,
    isSending: isSendingMessage,
    isStopping: stopping,
    pendingAdmissionWaiting: turnAdmission !== null && turnAdmission.phase !== 'failed',
    hasDraft: composerText.trim().length > 0 || composerAttachments.length > 0,
    canStop,
  });
  const isStoppingPhase = desktopComposerAction === 'stopping';
  const isPreLlmPhase = desktopComposerAction === 'loading';
  const isLlmRunningPhase =
    !isArchived && !isStoppingPhase && !isPreLlmPhase && online && isBotLlmRunningPhase(liveActivity.phase);
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
        ? '观察已结束（不断连 Agent）'
        : live
          ? awaitingAnswer ?? botActivityText(activity, t)
          : '正在建立观察…';

  function openInspector(tab: InspectorTab) {
    setInspectorTab((cur) => (cur === tab ? null : tab));
  }

  const inspectorPage = inspectorPages.find(page => page.id === inspectorTab);
  const isProfilePage = inspectorTab === 'profile';
  const isManagementPage = inspectorTab === 'management';
  const settingsTab = inspectorPage && inspectorPage.id !== 'management' ? inspectorPage.id : null;
  const inspectorTitle = inspectorPage?.label ??
    (isProfilePage ? '智能体资料' : inspectorTab === 'raw' ? '诊断与原始记录' : '虚拟桌面');
  const deleteConfirmation = confirmDelete && !isPrimary ? (
    <div className="confirm-delete-banner" role="alert" ref={deleteConfirmationRef} tabIndex={isManagementPage ? -1 : undefined}>
      <span>确定要永久删除智能体「{bot.role}」吗？此操作不可撤销。</span>
      <div className="confirm-delete-actions">
        <button
          type="button"
          className="primary-button danger-button"
          disabled={!online || manageBusy}
          onClick={() => void handleDelete()}
        >
          {manageAction === 'delete' ? '删除中…' : '确认永久删除'}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={manageBusy}
          onClick={() => {
            setConfirmDelete(false);
            if (isManagementPage) manageDeleteButtonRef.current?.focus();
          }}
        >
          取消
        </button>
      </div>
    </div>
  ) : null;
  const managementError = manageError ? (
    <ErrorNotice error={manageError} onDismiss={() => setManageError(null)} compact />
  ) : null;
  const example = '帮我梳理今天的待办事项。';

  return (
    <div className="chat-stage" ref={stageRef}>
      <div className="chat-column">
      {chatBoard.storageError && <p role="alert" className="bot-board-warning">{chatBoard.storageError}</p>}
      <header className="chat-header">
        <button
          type="button"
          className="chat-header-pill"
          onClick={() => openInspector('profile')}
          aria-label={`打开${bot.role}的智能体设置`}
          aria-haspopup="dialog"
          aria-expanded={isProfilePage || Boolean(inspectorPage)}
          title="智能体设置（Ctrl+.）"
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
            <span className="chat-header-pill-name">
              {isPrimary && !isArchived ? '★ ' : ''}{bot.role}
              {isArchived ? <span className="archived-pill">已归档</span> : null}
            </span>
            <span className="chat-header-pill-sub">
              {deviceName} · 模型 {bot.modelRef ?? '默认'}
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
                placeholder="搜索本会话…"
                aria-label="会话内搜索"
              />
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  setSearchOpen(false);
                  setChatSearch('');
                }}
                aria-label="关闭搜索"
              >
                <X size={14} />
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className={`icon-button${searchOpen ? ' active' : ''}`}
            onClick={() => {
              setSearchOpen((v) => {
                if (v) setChatSearch('');
                return !v;
              });
              window.setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
            title="会话内搜索（Ctrl+F）"
            aria-label="会话内搜索"
          >
            <Search size={17} />
          </button>
          <button
            type="button"
            className={`secondary-button chat-action-pill${inspectorTab === 'shower' ? ' active' : ''}`}
            onClick={() => openInspector('shower')}
            title="虚拟桌面（右侧工作台 / 全窗口模式在面板内切换）"
          >
            <Monitor size={15} /> 桌面
          </button>
          <div className="chat-more-wrap" ref={moreMenuRef}>
            <button
              type="button"
              className="icon-button"
              onClick={() => setMoreMenuOpen((v) => !v)}
              aria-label="更多操作"
              title="更多操作"
            >
              <MoreHorizontal size={17} />
            </button>
            {moreMenuOpen ? (
              <div className="chat-more-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); openInspector('profile'); }}>
                  <User size={14} /> 查看完整资料
                </button>
                {onOpenPrivateChats ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      onOpenPrivateChats(bot);
                    }}
                  >
                    <MessageSquare size={14} /> 查看智能体间通信
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  disabled={!online || manageBusy || isPrimary || isArchived}
                  title={isPrimary ? '已是主 Bot' : isArchived ? '已归档 Bot 不可设为主 Bot' : '将此 Bot 设为所属设备的主 Bot'}
                  onClick={() => { setMoreMenuOpen(false); void handleSetPrimary(); }}
                >
                  <Star size={14} /> {manageAction === 'setPrimary' ? '设置中…' : '设为主智能体'}
                </button>
                {!isArchived ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!online || manageBusy || isPrimary}
                    title={isPrimary ? '主 Bot 不可归档，请先切换主 Bot' : '归档此 Bot（14 天后自动删除）'}
                    onClick={() => { setMoreMenuOpen(false); onRequestArchive(); }}
                  >
                    <Archive size={14} /> 归档智能体
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!online || manageBusy}
                    onClick={() => { setMoreMenuOpen(false); void handleUnarchive(); }}
                  >
                    <Archive size={14} /> {manageAction === 'unarchive' ? '恢复中…' : '恢复智能体'}
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); openInspector('raw'); }}>
                  <History size={14} /> 诊断与原始记录
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger-item"
                  disabled={!online || manageBusy || isPrimary}
                  title={isPrimary ? '主 Bot 不可删除，请先切换主 Bot' : '删除此 Bot'}
                  onClick={() => { setMoreMenuOpen(false); setConfirmDelete(true); }}
                >
                  <Trash2 size={14} /> 永久删除智能体
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {awaitingAnswer ? <p className="chat-awaiting-answer" role="status">{awaitingAnswer}</p> : null}

      {isManagementPage ? null : deleteConfirmation}
      {isManagementPage ? null : managementError}

      {isArchived ? (
        <div className="archived-readonly-banner" role="status">
          <span>
            此 Bot 已归档（只读模式，不可发送消息）· 剩余 {remainingArchiveDays(bot.archivedAt)} 天后自动删除
            {bot.archivedAt ? `（归档于 ${formatTime(bot.archivedAt)}）` : ''}
          </span>
          <button
            type="button"
            className="secondary-button"
            disabled={!online || manageBusy}
            onClick={() => void handleUnarchive()}
          >
            {manageAction === 'unarchive' ? '恢复中…' : '恢复 Bot'}
          </button>
        </div>
      ) : null}

      {liveEnded && online && !liveError && !rawError ? (
        <div className="status live-ended-banner" role="status">
          观察已结束（不断连 Agent）。
          <button type="button" onClick={() => setWatchTick((t) => t + 1)}>重新观察</button>
        </div>
      ) : null}
      {!online && readsActive && !centerInterrupted ? (
        <div className="status status-offline-bar" role="status">
          <span>
            {identity
              ? `目标 ${deviceName}（${bot.role}）离线：显示最后读取的内容（只读），草稿保留；恢复在线后可继续发送。`
              : '连接已断开：显示最后读取的内容（只读），草稿保留。'}
          </span>
        </div>
      ) : null}

      <ChatTranscript
        entries={rawItems}
        live={live}
        bot={bot}
        knownBots={knownBots}
        activity={transcriptActivity}
        awaitingAnswer={Boolean(awaitingAnswer)}
        avatarKey={botAvatarKey(bot)}
        devicePlatform={devicePlatform}
        search={chatSearch}
        boardResultId={boardResultId}
        onViewedResult={onViewedResult}
        questionnaireRequestId={transcriptActive && live?.busy &&
          activity.phase !== 'stopping' && activity.phase !== 'interrupting' ? questionnaireRequestId : undefined}
        onQuestionnaireFocused={onQuestionnaireFocused}
        archived={isArchived}
        scopeKey={toolScopeKey}
        disabled={!online}
        onSubmitQuestionnaire={submitQuestionnaire}
        onSubmitVaultUnlock={submitVaultUnlock}
        attachmentFetcher={attachmentFetcher}
        loading={online && rawLoading}
        error={online ? (rawError || liveError) : null}
        hasMore={false}
        onLoadMore={() => void loadRaw()}
        onRetry={() => {
          setLiveError(null);
          setWatchTick((t) => t + 1);
          void loadRaw();
        }}
        onOpenLearnedSkills={() => openInspector('skill-review')}
        canEditTurns={canEditTurns}
        editingEntryId={activeEditing?.entryId ?? null}
        onEditTurn={startEditTurn}
        emptyActions={
          !isArchived && !drafts.text && <button
            type="button"
            className="secondary-button"
            disabled={disabled || !drafts.key}
            onClick={() => { onChangeText(example); composerRef.current?.focus(); }}
          >{example}</button>
        }
      />

      <Composer
        textareaRef={composerRef}
        text={composerText}
        onChangeText={onChangeText}
        files={composerFiles}
        onAddFile={addFile}
        onRemoveFile={removeFile}
        attachments={composerAttachments}
        onAddAttachment={addAttachment}
        onRemoveAttachment={removeAttachment}
        attachmentFetcher={attachmentFetcher}
        onPickImage={pickImage}
        canPick={!isArchived && !activeEditing && identity?.kind === 'local'}
        onPick={pickFile}
        draftError={activeEditing ? null : drafts.error}
        draftHint={isArchived ? '此 Bot 已归档，当前为只读模式，恢复后可继续发送消息。' : null}
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
        turnAdmission={activeEditing ? null : turnAdmission}
        onRetryTurnAdmission={() => void retryTurnAdmission()}
        onInsertSlash={(cmd) => drafts.editText(cmd)}
        onOpenSendRecord={activeEditing ? undefined : openSendRecord}
        queuedItems={queuedStripItems}
        queueBusy={queueBusy}
        onRecallQueued={(item) => void recallQueuedItem(item, true)}
        onRecallAllQueued={() => void recallAllQueued()}
        onDiscardQueued={(item) => void recallQueuedItem(item, false)}
        onSteerQueued={(item) => void steerQueuedItem(item)}
        isEditingTurn={Boolean(activeEditing)}
        onCancelEditTurn={() => {
          setEditingTurn(null);
          setSendError(null);
          window.setTimeout(() => composerRef.current?.focus(), 0);
        }}
      />
      </div>

      <Dialog.Root open={stopConfirmOpen} onOpenChange={open => {
        if (!open) setConfirmedStopTarget(null);
      }}>
        <Dialog.Portal>
          <Dialog.Overlay className="desktop-dialog-overlay" />
          <Dialog.Content className="desktop-dialog confirm-action-dialog" onCloseAutoFocus={event => {
            event.preventDefault();
            if (stopButtonRef.current && !stopButtonRef.current.disabled) stopButtonRef.current.focus();
            else stageRef.current?.querySelector<HTMLButtonElement>('.chat-header-pill')?.focus();
          }}>
            <div className="desktop-dialog-head"><Dialog.Title>停止智能体任务</Dialog.Title></div>
            <div className="confirm-action-body">
              <Dialog.Description>停止「{bot.role}」的所有进行中和排队任务，包括其他会话和后台任务。</Dialog.Description>
              <div className="form-actions">
                <Dialog.Close asChild><button type="button" className="secondary-button">取消</button></Dialog.Close>
                <button type="button" className="primary-button danger-button" onClick={() => {
                  if (!stopConfirmOpen) return;
                  setConfirmedStopTarget(null);
                  void stopTask();
                }}>确认停止</button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={inspectorTab !== null}
        modal={compactOverlay}
        onOpenChange={(open) => {
          if (!open) setInspectorTab(null);
        }}
      >
        <Dialog.Portal container={stageRef.current}>
          <Dialog.Overlay className="inspector-scrim" />
          <Dialog.Content
            ref={inspectorContentRef}
            className="inspector-drawer"
            aria-describedby={undefined}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              inspectorContentRef.current?.focus();
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              stageRef.current?.querySelector<HTMLButtonElement>('.chat-header-pill')?.focus();
            }}
          >
            <div className="inspector-head">
              {inspectorPage ? (
                <button type="button" className="icon-button" aria-label="返回资料" onClick={() => setInspectorTab('profile')}>
                  <ArrowLeft size={16} aria-hidden />
                </button>
              ) : null}
              <Dialog.Title className="inspector-title" ref={inspectorTitleRef} tabIndex={-1} aria-label={`${bot.role} · ${inspectorTitle}`}>
                {isProfilePage || inspectorPage ? inspectorTitle : `${bot.role} · ${inspectorTitle}`}
              </Dialog.Title>
              <button
                type="button"
                className="icon-button"
                onClick={() => setInspectorTab(null)}
                aria-label="关闭工作台"
                title="关闭工作台（Ctrl+.）"
              >
                <X size={16} />
              </button>
            </div>
            <div className="inspector-body" ref={inspectorBodyRef} onScroll={(event) => {
              if (isProfilePage) profileScrollRef.current = event.currentTarget.scrollTop;
            }}>
              <div className="inspector-section" hidden={!isProfilePage && !isManagementPage}>
                {isProfilePage ? <p className="metadata inspector-device">设备 · {deviceName}</p> : null}
                <div hidden={!isProfilePage}>
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
                  <nav className="inspector-links" aria-label="智能体设置">
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
                            <Icon size={17} aria-hidden />
                            <span className="inspector-link-label">{label}</span>
                            {id === 'model' ? <span className="metadata inspector-link-value">{bot.modelRef ?? '默认'}</span> : null}
                            <ChevronRight size={15} aria-hidden />
                          </button>
                        ))}
                      </section>
                    ))}
                  </nav>
                ) : null}
                {isManagementPage ? (
                  <section className="inspector-lifecycle" aria-label="智能体状态">
                    <h3 className="inspector-section-title">智能体状态</h3>
                    {isPrimary && !isArchived ? (
                      <p className="hint">主 Bot 不可归档/删除，请先切换主 Bot。</p>
                    ) : null}
                    <div className="form-actions">
                      {!isPrimary && !isArchived ? (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={!online || manageBusy}
                          onClick={() => void handleSetPrimary()}
                        >
                          {manageAction === 'setPrimary' ? '设置中…' : '★ 设为主 Bot'}
                        </button>
                      ) : null}
                      {!isArchived ? (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={!online || manageBusy || isPrimary}
                          onClick={onRequestArchive}
                        >
                          归档智能体
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={!online || manageBusy}
                          onClick={() => void handleUnarchive()}
                        >
                          {manageAction === 'unarchive' ? '恢复中…' : '恢复智能体'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="secondary-button danger-outline"
                        ref={manageDeleteButtonRef}
                        disabled={!online || manageBusy || isPrimary}
                        onClick={() => setConfirmDelete(true)}
                      >
                        永久删除智能体
                      </button>
                    </div>
                    {deleteConfirmation}
                    {managementError}
                  </section>
                ) : null}
              </div>
              {settingsTab ? (
                <BotSettings api={api} botId={bot.botId} hostLabel={deviceName} hostPlatform={devicePlatform} tab={settingsTab} open />
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
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
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

export function BotChats({
  api,
  currentDeviceId,
  pageActive = true,
  initialBotId,
  initialDeviceId,
  onArchiveBridge,
  boardActive = false,
  workspaceActive = pageActive,
  centerInterrupted = false,
  onOpenBoardChat,
  onOpenSendRecords,
  onOpenArchived,
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
  workspaceActive?: boolean;
  centerInterrupted?: boolean;
  onOpenBoardChat?: () => void;
  onOpenSendRecords?: (target?: SendRecordsTarget) => void;
  onOpenArchived?: () => void;
}) {
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
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

  const [bots, setBots] = useState<BotDirectoryEntry[]>(() => initialCache?.bots ?? []);
  const readScopes = useRef(new Map<string, BotReadScope>());
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
  const [showCreate, setShowCreate] = useState(false);
  const [createTargetDeviceId, setCreateTargetDeviceId] = useState('');
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [deviceFilter, setDeviceFilter] = useState<string>('all');
  /** 主舞台内子视图：null = 选中 Bot 的主聊天；dm = 某 Bot 的私聊列表（readOnly）；scope = 群聊详情。
   *  只保存稳定 deviceId/成员/scopeId，不保存 api：profileKey 不含 generation，
   *  冻结的 targetApi 会在同 profile 重连后 identity 永久 null、targetOnline 不随目录更新。 */
  const [stage, setStage] = useState<
    | null
    | { kind: 'dm'; member: MessageMember; name: string; deviceId: string }
    | { kind: 'scope'; scopeId: string; deviceId: string }
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
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target:
      | { kind: 'bot'; bot: BotDirectoryEntry }
      | { kind: 'group'; group: (typeof groupRows)[number] };
  } | null>(null);
  const [botActionError, setBotActionError] = useState<string | null>(null);
  const [botDeletionNotice, setBotDeletionNotice] = useState('');
  useEffect(() => {
    if (!botDeletionNotice) return;
    const timer = window.setTimeout(() => setBotDeletionNotice(''), 3000);
    return () => window.clearTimeout(timer);
  }, [botDeletionNotice]);
  const [confirmDeleteBot, setConfirmDeleteBot] = useState<BotDirectoryEntry | null>(null);
  const [deletingBotKey, setDeletingBotKey] = useState<string | null>(null);
  const [deleteBotError, setDeleteBotError] = useState<string | null>(null);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<ConfirmDeleteGroupState | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<BotDirectoryEntry | null>(null);
  const [archiving, setArchiving] = useState(false);
  const archiveFlight = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listMoreRef = useRef<HTMLDetailsElement>(null);
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
      setConfirmDeleteBot(null);
      setDeleteBotError(null);
      setConfirmDeleteGroup(null);
      setArchiveTarget(null);
      setShowCreate(false);
      setDeviceFilter('all');
      setQuery('');
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
  useEffect(() => {
    if (!workspaceActive || boardActive) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        setListCollapsed(false);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if (k === 'b') {
        e.preventDefault();
        setListCollapsed((v) => !v);
      } else if (k === 'f' && !stage && selected) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('botchats:chat-search'));
      } else if (e.key === '.' && !stage && selected) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('botchats:toggle-inspector'));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaceActive, boardActive, stage, selected]);

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
  const chatWorkspaceActive = pageActive && workspaceActive && !boardActive;
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
      if (!identity || !api.transportConnected || targetBot.isPrimary) return;
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
    [api, identity, removePin, triggerLoadBots, refreshGroups, readScopeFor],
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

  const openConversation = useCallback((target: SendRecordsTarget) => {
    if (!conversationName(target)) return;
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
    if (!confirmDeleteBot || deletingBotKey !== null) return;
    const targetBot = confirmDeleteBot;
    const key = `${targetBot.deviceId}:${targetBot.botId}`;
    setDeletingBotKey(key);
    setDeleteBotError(null);
    try {
      await deleteBotEntry(targetBot);
      setConfirmDeleteBot(null);
    } catch (e) {
      setDeleteBotError(`永久删除失败：${errText(e)}`);
    } finally {
      setDeletingBotKey(null);
    }
  }

  async function handleConfirmArchive() {
    if (!archiveTarget || !online || archiveFlight.current) return;
    const session = sessionRef.current;
    archiveFlight.current = true;
    setArchiving(true);
    try {
      await archiveBotEntry(archiveTarget);
    } catch {
      // archiveBotEntry 已保留可见错误。
    } finally {
      archiveFlight.current = false;
      setArchiving(false);
      if (sessionRef.current === session) setArchiveTarget(null);
    }
  }

  async function fetchLatestScopeForDelete(scopeInfo: ScopeInfo, reqId: string) {
    const scopeId = scopeInfo.scope.scopeId;
    const wApi = resolveRoomApi(scopeInfo, 'members');
    const wIdentity = wApi?.identity;
    if (!wApi || !wIdentity || !wApi.transportConnected) {
      setConfirmDeleteGroup((cur) =>
        cur && cur.scopeId === scopeId
          ? {
              ...cur,
              loadingLatest: false,
              loadError: '权威节点写通道未连接或离线，无法读取最新群状态以解散群聊。',
            }
          : cur,
      );
      return;
    }
    const localSess = sessionKey(wIdentity);
    setConfirmDeleteGroup((cur) =>
      cur && cur.scopeId === scopeId
        ? { ...cur, loadingLatest: true, loadError: null, deleteError: null }
        : cur,
    );
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
        setConfirmDeleteGroup(null);
        refreshGroups();
        return;
      }
      setConfirmDeleteGroup((cur) =>
        cur && cur.scopeId === scopeId
          ? {
              ...cur,
              latestScope: latest,
              requestId: reqId,
              loadingLatest: false,
              loadError: null,
            }
          : cur,
      );
    } catch (e) {
      if (sessionKey(wApi.identity) === localSess) {
        reportUnlessTargetOffline(wApi, e);
        setConfirmDeleteGroup((cur) =>
          cur && cur.scopeId === scopeId
            ? {
                ...cur,
                loadingLatest: false,
                loadError: `读取最新群状态失败：${errText(e)}；请重试读取后再确认解散。`,
              }
            : cur,
        );
      }
    }
  }

  function openConfirmDeleteGroup(g: (typeof groupRows)[number]) {
    const scopeId = g.scope.scope.scopeId;
    const reqId = crypto.randomUUID();
    setConfirmDeleteGroup({
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
    });
    void fetchLatestScopeForDelete(g.scope, reqId);
  }

  async function executeDeleteGroup() {
    if (
      !confirmDeleteGroup ||
      confirmDeleteGroup.loadingLatest ||
      confirmDeleteGroup.deleting ||
      confirmDeleteGroup.lockedUnknown ||
      !confirmDeleteGroup.latestScope
    ) {
      return;
    }
    const { latestScope, requestId } = confirmDeleteGroup;
    const scopeId = latestScope.scope.scopeId;
    const expectedRevision = latestScope.scope.revision;
    const wApi = resolveRoomApi(latestScope, 'members');
    const wIdentity = wApi?.identity;
    if (!wApi || !wIdentity || !wApi.transportConnected) {
      setConfirmDeleteGroup((cur) =>
        cur && cur.scopeId === scopeId
          ? { ...cur, deleteError: '权威节点写通道未连接或离线，无法执行解散并删除。' }
          : cur,
      );
      return;
    }
    const localSess = sessionKey(wIdentity);
    setConfirmDeleteGroup((cur) =>
      cur && cur.scopeId === scopeId ? { ...cur, deleting: true, deleteError: null } : cur,
    );
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
      setConfirmDeleteGroup(null);
      refreshGroups();
    } catch (e) {
      reportUnlessTargetOffline(wApi, e);
      if (sessionKey(wApi.identity) !== localSess) return;
      const code = (e as { code?: string })?.code;
      const outcome = (e as { outcome?: string })?.outcome;
      if (isNotSent(e)) {
        setConfirmDeleteGroup((cur) =>
          cur && cur.scopeId === scopeId
            ? {
                ...cur,
                deleting: false,
                deleteError: `解散未派发（not-sent）：${errText(e)}；可重试。`,
              }
            : cur,
        );
      } else if (outcome === 'responded') {
        if (code === 'REVISION_CONFLICT' || code === 'REQUEST_CONFLICT') {
          setConfirmDeleteGroup((cur) =>
            cur && cur.scopeId === scopeId
              ? {
                  ...cur,
                  latestScope: null,
                  requestId: crypto.randomUUID(),
                  deleting: false,
                  deleteError: '群状态已被更新（版本冲突），请点击“重新读取最新状态”后再确认解散。',
                }
              : cur,
          );
        } else {
          setConfirmDeleteGroup((cur) =>
            cur && cur.scopeId === scopeId
              ? {
                  ...cur,
                  deleting: false,
                  deleteError: `解散并删除群聊失败：${errText(e)}`,
                }
              : cur,
          );
        }
      } else {
        setConfirmDeleteGroup((cur) =>
          cur && cur.scopeId === scopeId
            ? {
                ...cur,
                deleting: false,
                lockedUnknown: true,
                deleteError: `解散结果未确认：${errText(e)}（原 requestId: ${requestId}）；为防重复提交已锁定，请关闭弹窗并刷新群列表核对状态，不会盲目重试。`,
              }
            : cur,
        );
      }
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
        onOpenMenu={(position) =>
          setMenu({
            ...position,
            target: { kind: 'group', group: g },
          })
        }
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
        preview={plainPreview(b.lastPreview)}
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
          setSelected({ deviceId: b.deviceId, botId: b.botId });
          setRoomSettingsOpen(false);
          setStage(null);
        }}
        onOpenMenu={(position) =>
          setMenu({
            ...position,
            target: { kind: 'bot', bot: b },
          })
        }
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
          icon: <Users size={15} />,
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
          icon: pinned ? <PinOff size={15} /> : <Pin size={15} />,
          onSelect: () => {
            setMenu(null);
            togglePin(pinKey);
          },
        },
        {
          key: 'delete-group',
          label: '解散并删除群聊',
          icon: <Trash2 size={15} />,
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
        label: '查看资料',
        icon: <User size={15} />,
        onSelect: () => {
          setMenu(null);
          setSelected({ deviceId: b.deviceId, botId: b.botId });
          setRoomSettingsOpen(false);
          setStage(null);
          setInspectorRequest({
            deviceId: b.deviceId,
            botId: b.botId,
            tab: 'profile',
            seq: Date.now(),
          });
        },
      },
    ];
    // 置顶资格：仅当前设备 Hero 主 Bot 不提供置顶；远端主 Bot 在列表中可正常置顶。
    if (canPin) {
      items.push({
        key: 'toggle-pin',
        label: pinned ? '取消置顶' : '置顶',
        icon: pinned ? <PinOff size={15} /> : <Pin size={15} />,
        onSelect: () => {
          setMenu(null);
          togglePin(pinKey);
        },
      });
    }
    items.push({
      key: 'view-dm',
      label: '查看智能体间通信',
      icon: <MessageSquare size={15} />,
      onSelect: () => {
        setMenu(null);
        openDmList({ deviceId: b.deviceId, botId: b.botId });
      },
    });
    // 主 Bot 保护：任何设备的主 Bot 不可直接归档或删除。
    if (canDeleteOrArchive && !isArchived) {
      items.push({
        key: 'archive-bot',
        label: '归档智能体',
        icon: <Archive size={15} />,
        disabled: !botOnline,
        onSelect: () => {
          setMenu(null);
          setArchiveTarget(b);
        },
      });
    }
    if (canDeleteOrArchive) {
      items.push({
        key: 'delete-bot',
        label: '永久删除智能体',
        icon: <Trash2 size={15} />,
        danger: true,
        disabled: !botOnline,
        onSelect: () => {
          setMenu(null);
          setDeleteBotError(null);
          setConfirmDeleteBot(b);
        },
      });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, isPinned, online, resolveRoomApi, togglePin, devices, currentDeviceId]);

  const groupToDissolve = confirmDeleteGroup?.latestScope ?? confirmDeleteGroup?.initialScope;
  const dissolveDeviceNames = groupToDissolve
    ? [...new Set(groupToDissolve.scope.members.map(member => member.deviceId))].map(deviceNameOf)
    : [];

  if (boardActive) return <BotBoard
    variant="desktop"
    targets={boardTargets}
    board={board}
    loading={!loaded || loading}
    error={botsError}
    onOpen={(target, questionnaire) => {
      const bot = boardBots.find(bot => botBoardKey(profileKey, bot.deviceId, bot.botId) === target.key);
      if (!bot) return;
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
      onOpenBoardChat?.();
    }}
  />;

  return (
    <div className={`bot-chats-layout${listCollapsed ? ' list-collapsed' : ''}`}>
      <aside className="hub-sidebar" aria-label="智能体名录">
        <div className="hub-hero-strip" role="list" aria-label="主智能体">
          {primaryBots.map((b) => (
            <HeroBotCard
              key={`${b.deviceId}:${b.botId}`}
              role="listitem"
              className={`hub-hero-card${!stage && selected?.deviceId === b.deviceId && selected.botId === b.botId ? ' selected' : ''}`}
              onOpen={() => {
                setSelected({ deviceId: b.deviceId, botId: b.botId });
                setRoomSettingsOpen(false);
                setStage(null);
              }}
              onOpenMenu={(position) =>
                setMenu({
                  ...position,
                  target: { kind: 'bot', bot: b },
                })
              }
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
                      !b.online || !online ? '离线' : '',
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
              title={`在 ${d.displayName || '未命名设备'} 创建主智能体`}
              onClick={() => {
                setCreateTargetDeviceId(d.deviceId);
                setShowCreate(true);
              }}
            >
              <span className="hub-hero-plus">＋</span>
              <span className="hub-hero-info">
                <span className="hub-hero-name">创建主智能体</span>
                <span className="hub-hero-node">{d.displayName || '未命名设备'}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="hub-search-wrap">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索对话…"
            aria-label="搜索智能体或群聊"
          />
          {query ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => setQuery('')}
              aria-label="清除搜索"
            >
              <X size={13} />
            </button>
          ) : (
            <kbd className="hub-search-kbd" aria-hidden="true">Ctrl K</kbd>
          )}
        </div>

        {devices.length > 1 ? (
          <label className="hub-device-filter">
            <span className="sr-only">按设备筛选</span>
            <select value={deviceFilter} onChange={event => setDeviceFilter(event.target.value)}>
              <option value="all">所有设备</option>
              {devices.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.displayName || '未命名设备'}{device.online && online ? '' : ' · 离线'}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {botsError ? (
          <div className="error-banner" role="alert">
            {botsError}
            <button type="button" onClick={() => triggerLoadBots()}>重试</button>
          </div>
        ) : null}
        {groupsError ? (
          <div className="error-banner" role="alert">
            {'群聊列表读取失败：' + groupsError}
            <button type="button" onClick={() => refreshGroups()}>重试</button>
          </div>
        ) : null}
        {pinsError ? (
          <div className="error-banner" role="alert">
            {pinsError}
          </div>
        ) : null}
        {botActionError ? (
          <div className="error-banner" role="alert">
            {botActionError}
            <button type="button" onClick={() => setBotActionError(null)}>关闭</button>
          </div>
        ) : null}
        {!online && !centerInterrupted ? <div className="status">离线：显示最后读取的 Bot 列表。</div> : null}

        <div className="hub-list-scroll">
          {loading && !loaded ? (
            <div className="status">加载中…</div>
          ) : !loaded ? (
            <div className="status">目录尚未读取。</div>
          ) : primaryBots.length === 0 && regularBots.length === 0 && groupRows.length === 0 && !botsError ? (
            <div className="empty-state">
              {query || deviceFilter !== 'all' ? '没有匹配的智能体或群聊。' : '暂无会话，可以先新建智能体。'}
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
              {groupsLoading ? <div className="status">群聊加载中…</div> : null}
            </>
          )}
        </div>

        <div className="hub-bottom-bar">
          <button
            type="button"
            className="primary-button hub-new-btn"
            onClick={() => {
              const preferredDevice = [stage?.deviceId, selectedBot?.deviceId, deviceFilter, currentDeviceId]
                .find(id => onlineDevices.some(device => device.deviceId === id));
              setCreateTargetDeviceId(preferredDevice ?? onlineDevices[0]?.deviceId ?? '');
              setShowCreate(true);
            }}
            disabled={!identity}
          >
            <Plus size={15} /> 新建智能体
          </button>
          <details className="hub-list-more" ref={listMoreRef} onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
          }}>
            <summary className="icon-button" aria-label="对话列表更多操作" title="对话列表更多操作"><MoreHorizontal size={16} /></summary>
            <div className="hub-list-more-actions">
              {onOpenSendRecords ? <button type="button" onClick={() => {
                listMoreRef.current?.removeAttribute('open');
                onOpenSendRecords();
              }}><History size={15} /> 发送记录</button> : null}
              {onOpenArchived ? <button type="button" onClick={() => {
                listMoreRef.current?.removeAttribute('open');
                onOpenArchived();
              }}><Archive size={15} /> 已归档智能体</button> : null}
              <button type="button" disabled={!online || loading} onClick={() => {
                listMoreRef.current?.removeAttribute('open');
                triggerLoadBots();
                void refreshGroups();
              }}><RefreshCw size={15} /> 刷新列表</button>
            </div>
          </details>
        </div>
      </aside>

      <section className="main-stage">
        {stage?.kind === 'dm' && stageApi ? (
          <div className="scope-main-stage">
            <Scopes
              key={JSON.stringify(['dm', profileKey, stage.member.deviceId, stage.member.botId])}
              api={stageApi}
              pageActive={pageActive}
              readOnly
              variant="desktop"
              scopeKind="dm"
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
        {scopedApi && selectedBot ? (
          <div className={stage ? 'chat-stage-host stage-hidden' : 'chat-stage-host'}>
          <PrimaryChatPane
            key={JSON.stringify([profileKey, selectedBot.deviceId, selectedBot.botId, selectedBot.primaryConversationId])}
            api={scopedApi}
            centerApi={api}
            bot={selectedBot}
            knownBots={scopeKnownBots}
            readScope={readScopeFor(selectedBot.deviceId, selectedBot.botId)}
            deviceName={selectedDeviceName}
            devicePlatform={selectedDevicePlatform}
            focusComposer={selected?.focusComposer}
            onOpenSendRecords={onOpenSendRecords}
            onRequestArchive={() => setArchiveTarget(selectedBot)}
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
            transcriptVisible={!showCreate && !confirmDeleteBot && !confirmDeleteGroup && !archiveTarget}
            pageActive={pageActive && workspaceActive && !stage}
          />
          </div>
        ) : null}
        {!stage && !(scopedApi && selectedBot) ? (
          <div className="empty-state stage-empty">
            <span className="title" role="status">{botDeletionNotice || '选择左侧智能体开始对话'}</span>
            {onlineDevices.length > 0 ? '或使用 Ctrl+K 快速搜索' : null}
          </div>
        ) : null}
      </section>

      <Dialog.Root open={showCreate} onOpenChange={setShowCreate}>
        <Dialog.Portal>
          <Dialog.Overlay className="desktop-dialog-overlay" />
          <Dialog.Content className="desktop-dialog create-bot-dialog" aria-describedby={undefined}>
            <div className="desktop-dialog-head">
              <Dialog.Title>新建智能体</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="icon-button" aria-label="关闭">
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            {identity ? (
              <CreateBotForm
                api={api}
                devices={devices}
                bots={bots}
                initialDeviceId={createTargetDeviceId}
                onCreated={(deviceId, bot) => {
                  setShowCreate(false);
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
                        deviceName: dev?.displayName || '未命名设备',
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
      <Dialog.Root open={archiveTarget !== null} onOpenChange={open => {
        if (!open && !archiveFlight.current) setArchiveTarget(null);
      }}>
        <Dialog.Portal>
          <Dialog.Overlay className="desktop-dialog-overlay" />
          <Dialog.Content className="desktop-dialog confirm-action-dialog">
            <div className="desktop-dialog-head"><Dialog.Title>归档智能体</Dialog.Title></div>
            <div className="confirm-action-body">
              <Dialog.Description>归档「{archiveTarget?.role}」后，对话转为只读。归档满 {ARCHIVE_RETENTION_DAYS} 天会自动清理，期间可在已归档智能体里恢复。</Dialog.Description>
              <div className="form-actions">
                <Dialog.Close asChild><button type="button" className="secondary-button" disabled={archiving}>取消</button></Dialog.Close>
                <button type="button" className="primary-button" onClick={() => void handleConfirmArchive()} disabled={archiving || !online}>
                  {archiving ? '正在归档…' : '确认归档'}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={confirmDeleteBot !== null}
        onOpenChange={(open) => {
          if (!open && deletingBotKey === null) {
            setConfirmDeleteBot(null);
            setDeleteBotError(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="desktop-dialog-overlay" />
          <Dialog.Content className="desktop-dialog confirm-action-dialog" aria-describedby={undefined}>
            <div className="desktop-dialog-head">
              <Dialog.Title>永久删除智能体</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭"
                  disabled={deletingBotKey !== null}
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            {confirmDeleteBot ? (
              <div className="confirm-action-body">
                <p>
                  确定要永久删除智能体「{confirmDeleteBot.role}」吗？删除后该智能体的所有对话历史与人设配置将永久清除，此操作不可撤销。
                </p>
                {deleteBotError ? (
                  <div className="error-banner" role="alert">
                    {deleteBotError}
                  </div>
                ) : null}
                <div className="form-actions">
                  <button
                    type="button"
                    className="primary-button danger-button"
                    disabled={deletingBotKey !== null || !online || !confirmDeleteBot.online}
                    onClick={() => void handleConfirmDeleteBot()}
                  >
                    {deletingBotKey !== null ? '删除中…' : '确认永久删除'}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={deletingBotKey !== null}
                    onClick={() => {
                      setConfirmDeleteBot(null);
                      setDeleteBotError(null);
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={confirmDeleteGroup !== null}
        onOpenChange={(open) => {
          if (!open && !confirmDeleteGroup?.deleting) {
            setConfirmDeleteGroup(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="desktop-dialog-overlay" />
          <Dialog.Content className="desktop-dialog confirm-action-dialog" aria-describedby={undefined}>
            <div className="desktop-dialog-head">
              <Dialog.Title>解散并删除群聊</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭"
                  disabled={confirmDeleteGroup?.deleting}
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            {confirmDeleteGroup ? (
              <div className="confirm-action-body">
                <p>
                  确定要解散并删除群聊「{confirmDeleteGroup.title}」吗？
                  {dissolveDeviceNames.length ? `涉及 ${dissolveDeviceNames.length} 台参与设备（${dissolveDeviceNames.join('、')}）。` : ''}
                  群聊历史和成员关系会被永久删除。
                </p>
                {confirmDeleteGroup.loadingLatest ? (
                  <div className="status">正在从权威节点读取最新群状态…</div>
                ) : null}
                {confirmDeleteGroup.loadError ? (
                  <div className="error-banner" role="alert">
                    {confirmDeleteGroup.loadError}
                    <button
                      type="button"
                      onClick={() =>
                        void fetchLatestScopeForDelete(
                          confirmDeleteGroup.initialScope,
                          confirmDeleteGroup.requestId,
                        )
                      }
                      disabled={confirmDeleteGroup.loadingLatest}
                    >
                      重试读取
                    </button>
                  </div>
                ) : null}
                {confirmDeleteGroup.deleteError ? (
                  <div className="error-banner" role="alert">
                    {confirmDeleteGroup.deleteError}
                  </div>
                ) : null}
                {!confirmDeleteGroup.loadingLatest &&
                !confirmDeleteGroup.loadError &&
                !confirmDeleteGroup.latestScope &&
                !confirmDeleteGroup.lockedUnknown ? (
                  <div className="form-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() =>
                        void fetchLatestScopeForDelete(
                          confirmDeleteGroup.initialScope,
                          confirmDeleteGroup.requestId,
                        )
                      }
                    >
                      重新读取最新状态
                    </button>
                  </div>
                ) : null}
                <div className="form-actions">
                  <button
                    type="button"
                    className="primary-button danger-button"
                    disabled={
                      confirmDeleteGroup.loadingLatest ||
                      confirmDeleteGroup.deleting ||
                      confirmDeleteGroup.lockedUnknown ||
                      !confirmDeleteGroup.latestScope ||
                      !online
                    }
                    onClick={() => void executeDeleteGroup()}
                  >
                    {confirmDeleteGroup.deleting ? '正在解散…' : '确认解散并删除'}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={confirmDeleteGroup.deleting}
                    onClick={() => setConfirmDeleteGroup(null)}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}
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
