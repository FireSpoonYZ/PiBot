// Bot 私聊 lane（desktop/web）：Hub 列表栏 + 主对话舞台 + 右侧工作台抽屉。
// 设计依据 desktop-gui-fresh-argon-design §5.2/§5.3/§5.4；
// 全部请求仍走既有 useDrafts / pending_enqueue / pending_send / observe 路径，
// 保留 CAS、显式发送、结果未确认锁与离线只读语义。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Archive,
  ArrowUp,
  Eraser,
  FileText,
  History,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Palette,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Shrink,
  Sparkles,
  Square,
  Star,
  Trash2,
  User,
  Users,
  X,
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
import { useText } from '../../../web/src/ui';
import type {
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
  ScopeInfo,
} from '../../../host-core/index.js';
import { isTargetOfflineError } from './api';
import { useDrafts } from './drafts';
import type { DraftSnapshot } from './drafts';
import { type QuestionnaireSubmitPayload } from '../../../web/src/ToolPresentation';
import { GrokBotAvatar } from '../../../web/src/GrokBotAvatar';
import {
  botActivityText,
  canStopBotActivity,
  isBotActivityBusy,
  resolveBotActivity,
  type BotActivity,
} from '../../../web/src/botActivity';
import { botAvatarKey, syncBotAvatarConfigs } from '../../../web/src/botAvatarSync';
import { BotSettings } from './BotSettings';
import { ShowerPreview } from './ShowerPreview';
import { ChatTranscript } from './ChatTranscript';
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

export function remainingArchiveDays(archivedAt: string | null | undefined): number {
  if (!archivedAt) return ARCHIVE_RETENTION_DAYS;
  const archivedMs = Date.parse(archivedAt);
  if (Number.isNaN(archivedMs)) return ARCHIVE_RETENTION_DAYS;
  const expireMs = archivedMs + ARCHIVE_RETENTION_DAYS * MS_PER_DAY;
  return Math.max(0, Math.ceil((expireMs - Date.now()) / MS_PER_DAY));
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

const TURN_ADMISSION_LABELS: Record<TurnAdmissionView['phase'], string> = {
  queued: '排队等待准入',
  checking: '正在核对 Center 版本集',
  synchronizing: '正在同步插件版本',
  failed: '准入失败',
};

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
          const args = part.arguments;
          const argsText = args && typeof args === 'object' ? JSON.stringify(args) : '';
          lines.push(`[工具调用] ${part.name}${argsText ? ' ' + argsText : ''}`);
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
  const summary = entryTextLines(entry).join('\n');
  return (
    <div className="raw-entry">
      <div className="raw-entry-head">
        <span className="raw-entry-id">{String(entry.id)}</span>
        <span className="raw-entry-kind">{entry.kind}</span>
      </div>
      {summary ? <p className="raw-entry-text">{summary}</p> : null}
      <details className="raw-entry-json">
        <summary>原始 JSON</summary>
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
  const [makePrimary, setMakePrimary] = useState(true);
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
    if (initialDeviceId) {
      setDeviceId(initialDeviceId);
      const hasPrimary = bots.some(
        (b) => b.deviceId === initialDeviceId && b.isPrimary && !b.archivedAt,
      );
      setMakePrimary(!hasPrimary);
    }
  }, [initialDeviceId, bots]);

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
    const hasPrimary = Boolean(
      nextDeviceId &&
        bots.some((b) => b.deviceId === nextDeviceId && b.isPrimary && !b.archivedAt),
    );
    setMakePrimary(!hasPrimary);
  }

  async function submit() {
    if (sendingRef.current || busy || locked) return;
    if (!deviceId || !devices.some((d) => d.deviceId === deviceId && d.online)) {
      setError('请选择在线目标设备；目标失效时不会改用本机。');
      return;
    }
    if (!role.trim()) {
      setError('Bot 名称必填');
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
        `${errText(e)}（原 requestId: ${requestId}；未确认结果请在待发送面板选择原设备对账，不会自动重发）`,
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
        目标设备
        <select
          value={deviceId}
          onChange={(e) => handleSelectDevice(e.target.value)}
          disabled={busy || locked}
        >
          <option value="">请选择设备</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId} disabled={!d.online}>
              {d.displayName || d.deviceId} · {d.deviceId} {d.online ? '在线' : '离线'}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Bot 名称
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={busy || locked}
        />
      </label>
      <label className="field">
        职责
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          disabled={busy || locked}
        />
      </label>
      <label className="field">
        cwd（可选；留空使用目标默认工作区）
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          disabled={busy || locked}
        />
      </label>
      <label className="field checkbox-field">
        <input
          type="checkbox"
          checked={effectiveMakePrimary}
          disabled={busy || locked || forcePrimary}
          onChange={(e) => setMakePrimary(e.target.checked)}
        />
        <span>设为主 Bot (makePrimary)</span>
      </label>
      {forcePrimary ? (
        <p className="hint">该设备当前尚无未归档的主 Bot，已强制勾选并锁定设为主 Bot。</p>
      ) : null}
      <p className="hint">模型由中心管理，新 Bot 使用中心默认配置。</p>
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="primary-button" disabled={busy || locked || !api.transportConnected}>
          {busy ? '创建中…' : effectiveMakePrimary ? '创建主 Bot' : '创建 Bot'}
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

function Composer({ text, onChangeText, files, onAddFile, onRemoveFile, attachments, onAddAttachment, onRemoveAttachment, attachmentFetcher, onPickImage, canPick, onPick, draftError, draftHint, draftConflict, sendState, sendError, sendNotice, onSend, canSend, disabled, onRetryDraft, attempt, recOutcome, onReconcile, onReleaseNotSent, onRetryClearVerified, onAdoptNewerDraft, turnAdmission, onRetryTurnAdmission, onInsertSlash }: {
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
  sendError: string | null;
  /** 发送路径的短时可见提示（slash 进度/结果）；与 sendError 只保留其一。 */
  sendNotice: string | null;
  onSend: () => void;
  canSend: boolean;
  disabled: boolean;
  onRetryDraft: () => void;
  attempt: { id: string; phase: string; pendingId: string | null; error: string | null; businessId: string } | null;
  recOutcome: { action: string; found: boolean; recordId: string | null; recordState: string | null } | null;
  onReconcile: () => void;
  onReleaseNotSent: () => void;
  onRetryClearVerified: () => void;
  onAdoptNewerDraft: () => void;
  /** 最新可见的 Host 准入状态（来自原 pending 记录 receipt.admission）；null 表示无等待项。 */
  turnAdmission: TurnAdmissionView | null;
  /** Host 准入失败后的显式重试：沿用冻结的同一 requestId/文本重新入队，不自动重发。 */
  onRetryTurnAdmission: () => void;
  /** 斜杠命令先填回输入框；用户显式发送后由发送路径调用 clearHistory/compact，不当作模型 prompt。 */
  onInsertSlash: (command: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [dismissedSlash, setDismissedSlash] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);

  /** 自适应高度：36px ~ 160px（设计 §5.3 胶囊输入区）。 */
  const autosize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, Math.max(36, el.scrollHeight))}px`;
  }, []);

  useEffect(() => {
    autosize();
  }, [text, autosize]);

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

  const slashOpen = slashMatches.length > 0 && !disabled && dismissedSlash !== text;

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
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend && !disabled) onSend();
    }
  }

  return (
    <div className="composer">
      {draftError ? (
        <div className="error-banner" role="alert">
          {draftError}
          <button type="button" onClick={onRetryDraft}>重试保存</button>
        </div>
      ) : null}
      {draftConflict ? (
        <div className="status">
          磁盘上的新版草稿：{truncate(draftConflict.text, 160) || '（空文本）'}
          {draftConflict.files.length > 0 ? `（${draftConflict.files.length} 个文件引用）` : ''}
        </div>
      ) : null}
      {attempt ? (
        <div className="error-banner" role="alert" aria-live="polite">
          {attempt.phase === 'not-sent' ? (
            <>
              发送未入队（not-sent）：{attempt.error}
              <button type="button" onClick={() => onReleaseNotSent()}>恢复编辑</button>
            </>
          ) : (
            <>
              发送冻结中 · 业务ID {attempt.businessId}{attempt.pendingId ? ` · pending ${attempt.pendingId}` : ''}（{attempt.phase}）。
              {attempt.phase === 'cleared' || attempt.phase === 'failed' || attempt.phase === 'unconfirmed' ? (
                <button type="button" onClick={() => onReconcile()}>查询原记录</button>
              ) : null}
              {draftConflict && recOutcome?.found ? (
                <button type="button" onClick={() => onAdoptNewerDraft()}>保留新版草稿，结束旧尝试</button>
              ) : null}
              {recOutcome?.action === 'ready-clear-retry' ? (
                <button type="button" onClick={() => onRetryClearVerified()}>重试本地清空</button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {turnAdmission ? (
        <div className={'status' + (turnAdmission.phase === 'failed' ? ' error' : ' busy')} role="status" aria-live="polite">
          {TURN_ADMISSION_LABELS[turnAdmission.phase]}
          {turnAdmission.source === 'background' ? ' · 后台' : null}
          {turnAdmission.error
            ? '（' + turnAdmission.error.code + (turnAdmission.error.message ? '：' + truncate(turnAdmission.error.message, 120) : '') + '）'
            : null}
          {' · 同一 requestId 等待中心准入'}
          {turnAdmission.phase === 'failed' && onRetryTurnAdmission ? (
            <button type="button" onClick={() => onRetryTurnAdmission()}>重试准入</button>
          ) : null}
        </div>
      ) : null}
      {files.length > 0 ? (
        <p className="hint">已引用 {files.length} 个路径，发送时按原文引用，不会上传文件。</p>
      ) : null}
      {files.length > 0 ? (
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
          <div className="composer-plus-wrap" ref={moreRef}>
            <button
              type="button"
              className="icon-button composer-plus"
              disabled={disabled}
              aria-label="更多操作"
              title="添加文件引用 / 斜杠命令"
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
                {!canPick ? (
                  <p className="composer-plus-note" role="note">
                    Relay 模式不可选本机文件；可将目标 Host 上已存在的路径作为普通文本引用。
                  </p>
                ) : null}
                {SLASH_COMMANDS.map((c) => (
                  <button
                    key={c.command}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      pickSlash(c.command);
                    }}
                  >
                    {c.command === '/clear' ? <Eraser size={14} /> : <Shrink size={14} />} {c.label} · {c.desc}
                  </button>
                ))}
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
            placeholder="输入消息，/ 呼出命令…"
            rows={1}
            disabled={disabled}
          />
          <button
            type="button"
            className="composer-send primary-button"
            onClick={() => onSend()}
            disabled={disabled || !canSend}
            aria-label="发送"
            title="Enter 发送 · Shift+Enter 换行"
          >
            {sendState === 'sending' ? '…' : <ArrowUp size={16} />}
          </button>
        </div>
      </div>
      {sendError ? <div className="error-banner" role="alert">{sendError}</div> : null}
      {sendNotice ? <div className="status" role="status">{sendNotice}</div> : null}
      <div className="composer-footer">
        <p className="hint">
          Enter 发送 · Shift+Enter 换行 · / 呼出命令
          {draftHint ? ` · ${draftHint}` : ''}
        </p>
      </div>
    </div>
  );
}

function BotProfile({ api, centerApi, bot, onSaved }: { api: DesktopPanelApi; centerApi: DesktopPanelApi; bot: BotRecord; onSaved: (bot: BotRecord) => void }) {
  const [name, setName] = useState(bot.role);
  const [description, setDescription] = useState(bot.description ?? '');
  const [cwd, setCwd] = useState(bot.cwd);
  const [cwdRevision, setCwdRevision] = useState<number | null>(null);
  const [cwdFailed, setCwdFailed] = useState(false);
  const [cwdNotice, setCwdNotice] = useState<string | null>(null);
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

  // 只有真实目标/会话身份变化才清草稿；目录更新、引用变化不清。
  // 中心重连也重读修订（可能在他处变更），但不丢草稿。
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
      setCwd(bot.cwd);
    }
    // 修订一律作废再重读：同会话重连、身份切换、离开/挂载都会先失效旧请求。
    cwdFetchRef.current++;
    setCwdRevision(null);
    setCwdFailed(false);
    void loadCwdRef.current();
    return () => { cwdFetchRef.current++; };
  }, [cwdIdentity, centerSess, centerOnline]);

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
      setCwdNotice(null);
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
    setBusy(true);
    setError(null);
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
        setError('工作目录已被其他修改占用；请重新读取后再保存。');
      } else {
        setError('工作目录保存失败：' + errText(e));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="form-grid inspector-profile-form">
      <label className="field">名称<input value={name} maxLength={120} disabled={busy || locked || isArchived} onChange={(e) => { dirty.current = true; setName(e.target.value); }} /></label>
      <label className="field">职责<textarea value={description} maxLength={2000} disabled={busy || locked || isArchived} onChange={(e) => { dirty.current = true; setDescription(e.target.value); }} /></label>
      <label className="field">
        工作目录
        <input
          value={cwd}
          disabled={busy || isArchived}
          placeholder="目标 Host 上的绝对路径"
          onChange={(e) => { cwdDirty.current = true; setCwd(e.target.value); setCwdNotice(null); }}
        />
      </label>
      <p className="hint">
        目标 Host 上的绝对路径；保存到中心后该 Bot 空闲时生效；不会移动文件。
        {cwdFailed ? '（未能从中心读取修订，请重新读取后再保存）' : cwdRevision === null ? '（正在读取中心修订…）' : ''}
      </p>
      {cwdNotice ? <div className="status" role="status">{cwdNotice}</div> : null}
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      <div className="form-actions">
        {locked ? (
          <button type="button" className="secondary-button" disabled={busy || !api.transportConnected} onClick={() => void adoptRemote()}>读取并采用远端资料（丢弃草稿）</button>
        ) : null}
        <button type="button" className="secondary-button" onClick={() => void saveCwd()} disabled={busy || isArchived || !centerOnline || !cwdSavable}>保存工作目录</button>
        {(cwdFailed || (error && cwdRevision === null)) ? (
          <button type="button" className="secondary-button" disabled={busy || !centerOnline} onClick={() => void loadCwdRef.current()}>重新读取目录修订</button>
        ) : null}
        <button type="button" className="primary-button" onClick={() => void save()} disabled={busy || locked || isArchived || !api.transportConnected}>保存资料</button>
      </div>
    </div>
  );
}

type InspectorTab = 'profile' | 'settings' | 'raw' | 'shower';

function PrimaryChatPane({
  api,
  centerApi,
  bot,
  deviceName,
  devicePlatform,
  onProfileSaved,
  onBotUpdated,
  onBotDeleted,
  onLiveActivity,
  onOpenPrivateChats,
  inspectorRequest = null,
  pageActive = true,
}: {
  api: DesktopPanelApi;
  /** 未按目标在线收窄的原 api：仅中心权威操作（cwd get/set）使用。 */
  centerApi: DesktopPanelApi;
  bot: BotRecord;
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
  inspectorRequest?: { tab: InspectorTab; seq: number } | null;
  pageActive?: boolean;
}) {
  const t = useText();
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
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
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const [slashBusy, setSlashBusy] = useState<SlashCommandName | null>(null);
  const [recOutcome, setRecOutcome] = useState<{ action: string; found: boolean; recordId: string | null; recordState: string | null } | null>(null);
  const lockedRef = useRef(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab | null>(null);
  const [chatSearch, setChatSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /** 本聊天最新的 Host 准入状态（Host-queued 回执中的 admission）；null 表示无等待项。 */
  const [turnAdmission, setTurnAdmission] = useState<TurnAdmissionView | null>(null);
  /** 抽屉 Portal 容器：紧凑模态只锁本聊天气泡层，不影响左栏名录与导航。 */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const inspectorContentRef = useRef<HTMLDivElement | null>(null);

  const [manageAction, setManageAction] = useState<'setPrimary' | 'archive' | 'unarchive' | 'delete' | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
      onBotUpdated({
        ...(updated && typeof updated === 'object' ? (updated as Partial<BotRecord>) : {}),
        botId: bot.botId,
        archivedAt,
        isPrimary: false,
      });
    } catch (e) {
      if (mountedRef.current && sessionKey(api.identity) === sess) {
        setManageError(`归档失败：${tErr(e)}`);
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
    try {
      await api.call(identity, 'deleteBot', { botId: bot.botId });
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      setConfirmDelete(false);
      onBotDeleted(bot.botId);
    } catch (e) {
      if (mountedRef.current && sessionKey(api.identity) === sess) {
        setManageError(`删除失败：${tErr(e)}`);
        reportUnlessTargetOffline(api, e);
      }
    } finally {
      manageInFlightRef.current = false;
      if (mountedRef.current) setManageAction(null);
    }
  }

  function onChangeText(v: string) {
    drafts.editText(v);
    if (sendError) setSendError(null);
  }

  function addFile(ref: { name: string; path: string; size: number }) {
    drafts.addFile(ref);
  }

  function removeFile(i: number) {
    drafts.removeFile(i);
  }

  function addAttachment(att: ImageAttachment) {
    drafts.addAttachment(att);
  }

  function removeAttachment(i: number) {
    drafts.removeAttachment(i);
  }

  const attachmentFetcher = useMemo<AttachmentFetcher | null>(() => {
    if (!identity) return null;
    return async (attachmentId) => api.call(identity, 'getAttachment', { botId: bot.botId, attachmentId }) as Promise<ImageAttachmentData>;
  }, [api, identity, bot.botId]);

  async function pickFile() {
    if (!identity || lockedRef.current || isArchived) return;
    try {
      const ref = await api.pickFile();
      if (ref && !lockedRef.current) addFile(ref);
    } catch (e) {
      api.reportError(e);
      setSendError('选择文件失败：' + errText(e));
    }
  }

  const [imageUploading, setImageUploading] = useState(false);

  /** 桌面只选图（无原生相机）；上传归属冻结在发起时的 identity/botId/draftKey。
   *  addAttachment 的 expectedKey 是原子 guard（useDrafts 内部 keyRef 实时比较）：
   *  切换 Bot/身份后未完成批次中止，已上传结果不写新 scope 草稿。
   *  相同图片 id 去重；去重后总数 ≤4，超限整体拒绝保留原草稿。 */
  function pickImage() {
    const frozenIdentity = identity;
    const draftKey = drafts.key;
    if (!frozenIdentity || lockedRef.current || isArchived || !draftKey || imageUploading) return;
    setImageUploading(true);
    pickImagesFromInput({
      onPicked: async (files) => {
        try {
          const normalized = await Promise.all(files.map((file) => normalizeImageFile(file, file.name)));
          const existing = new Set(drafts.attachments.map((a) => a.id));
          const queued: PickedImageSource[] = [];
          for (const source of normalized) {
            const id = await attachmentIdOf(source.data);
            if (existing.has(id)) continue;
            existing.add(id);
            queued.push(source);
          }
          if (drafts.attachments.length + queued.length > IMAGE_MAX_COUNT) {
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
            if (!drafts.addAttachment(att, draftKey)) return; // key 已切换：中止剩余批次
          }
          setSendError(null);
        } catch (e) {
          api.reportError(e);
          setSendError('选择图片失败：' + errText(e));
        }
      },
      onSettled: () => setImageUploading(false),
    });
  }

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
    setSendNotice(command === '/clear' ? '正在清空对话…' : '正在压缩上下文…');
    try {
      const result = await api.call(current, command === '/clear' ? 'clearHistory' : 'compact', { botId: bot.botId });
      if (!mountedRef.current || sessionKey(api.identity) !== sess) return;
      // 服务端已成功后才清命令草稿：沿用 clearDraft CAS，仅当持久草稿仍是该命令文本且无文件
      // 引用时清空；等待期间写入的新文本保留（与手机端 runSlashCommand 同约定）。
      const persisted = api.snapshot?.state.drafts[draftKey];
      if (persisted && persisted.text === draftText && persisted.files.length === 0) {
        try {
          await api.clearDraft(draftKey, [{ text: draftText, files: [] }]);
          if (drafts.text === draftText) drafts.editText('');
        } catch {
          // CAS 冲突/写失败：持久草稿保留，不掩盖服务端已成功的事实。
        }
      } else if (drafts.text === draftText) {
        drafts.editText('');
      }
      // 服务端成功后立即重读完整可见历史（busy 下降沿兜底也会补跑）。
      void loadRawLatest();
      setSendNotice(
        command === '/clear'
          ? '已清空当前对话并重置上下文'
          : (result as CompactResult | undefined)?.compacted
            ? '已压缩较早的上下文'
            : '没有可压缩的历史',
      );
      window.setTimeout(() => {
        if (mountedRef.current) setSendNotice(null);
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

  async function handleSend() {
    if (!identity || sendState !== 'idle' || lockedRef.current || isArchived) return;
    if (imageUploading) return;
    const msg = drafts.text.trim();
    const attachmentIds = drafts.attachments.map((a) => a.id);
    if (!msg && attachmentIds.length === 0) return;
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
    };
    const started = drafts.beginSend(input);
    if (!started) return;
    lockedRef.current = true;
    setSendState('sending');
    setSendError(null);
    setRecOutcome(null);
    await drafts.waitQuiet(started.handle);
    // 只发送冻结副本：await 后不重组身份/业务 ID。
    const frozen = started.attempt.input;
    const businessId = frozen.kind === 'primary' ? frozen.requestId : frozen.messageId;
    try {
      let rec: PendingRecord | null = null;
      try {
        rec = await api.pending(identity, 'pending_enqueue', { input: frozen });
      } catch (e) {
        reportUnlessTargetOffline(api, e);
        // 只有本阶段明确 not-sent（无队列记录）才可声称未入队。
        if (isNotSent(e)) {
          const errMsg = `发送未入队（not-sent）：${tErr(e)}。原 requestId ${businessId} 已冻结，无队列记录，可恢复编辑后重试。`;
          drafts.markNotSent(started.handle, errMsg);
          setSendError(errMsg);
        } else {
          const errMsg = `入队结果未确认：${tErr(e)}（原 requestId ${businessId}）；保持原 ID 锁，请查询原记录，不会自动补发。`;
          drafts.markUnconfirmed(started.handle);
          setSendError(errMsg);
        }
        return;
      }
      if (!rec) return;
      drafts.setPending(started.handle, rec.id);
      const pendingId = rec.id;
      const cleared = await drafts.confirmCleared(started.handle);
      if (cleared !== 'cleared') {
        const errMsg = cleared === 'conflict'
          ? `草稿尚未清空：磁盘草稿已被更新。原队列记录 ${pendingId} 保留，未发送；请查看新版草稿并选择“保留新版草稿，结束旧尝试”，不会自动清空或补发。`
          : `草稿尚未清空：消息已入队（${pendingId}）但未远程发送，请在待发送面板处理。`;
        drafts.markFailed(started.handle, errMsg);
        setSendError(errMsg);
        return;
      }
      if (!api.transportConnected) {
        drafts.finishSend(started.handle);
        setSendError(`离线：已入队（${pendingId}），连接后请在待发送面板显式发送。`);
        return;
      }
      try {
        const sent = await api.pending(identity, 'pending_send', { id: pendingId });
        reportSendRecord(started.handle, sent, pendingId);
      } catch (e) {
        // 回执丢失/超时/未知：已入队，保留原 ID 锁，绝不标未入队。
        reportUnlessTargetOffline(api, e);
        drafts.markUnconfirmed(started.handle);
        setSendError(`发送回执未确认：已入队（${pendingId}）· ${tErr(e)}；保持原 ID 锁，请查询原记录，不会自动补发。`);
      }
    } finally {
      lockedRef.current = false;
      setSendState('idle');
    }
  }

  function reportSendRecord(handle: { key: string; attemptId: string }, rec: PendingRecord, originalPendingId: string) {
    const hostQueued = readHostQueuedReceipt(rec);
    // Host-queued：本地已持久化并等待中心准入，submissionId 为 null 属正常，不视为缺失。
    setTurnAdmission(hostQueued ? hostQueued.admission : null);
    if (rec.state === 'accepted') {
      drafts.finishSend(handle);
      // 受理只说明已受理；完成与否以 live/原回执为准，界面不断言。
      setSendError(hostQueued
        ? '已受理（accepted）：提交已入 Host 队列等待准入（submissionId 未定）。结果以 live 或原回执为准。'
        : '已受理（accepted）。结果以 live 或原回执为准。');
      onLiveActivityRef.current?.();
    } else if (rec.state === 'rejected') {
      // 确定终态：本地 attempt 结束，原记录保留在待发送面板
      drafts.finishSend(handle);
      setSendError(`发送被拒：${rec.lastError?.code ?? '未知'}。原记录 ${rec.id} 可在待发送面板查看。`);
    } else if (rec.state === 'unconfirmed') {
      const errMsg = `发送结果未确认（unconfirmed），原记录 ${rec.id} 请等待待发送面板对账。`;
      drafts.markUnconfirmed(handle);
      setSendError(errMsg);
    } else {
      drafts.finishSend(handle);
      setSendError(hostQueued
        ? `消息已入 Host 队列等待准入（${originalPendingId}）${hostQueued.admission ? '：' + TURN_ADMISSION_LABELS[hostQueued.admission.phase] : ''}；结果以 live 或原回执为准。`
        : `消息状态：${rec.state}（${originalPendingId}）。`);
    }
  }

  async function queryPending() {
    if (!identity || !drafts.attempt || !drafts.key) return;
    const handle = { key: drafts.key, attemptId: drafts.attempt.id };
    const outcome = await drafts.reconcile(handle);
    if (!mountedRef.current) return;
    setRecOutcome(outcome);
    if (outcome.note) {
      setSendError(outcome.note);
    } else if (outcome.action === 'finished') {
      setSendError(`对账：原记录已确定（${outcome.recordState}），本地 attempt 已结束。`);
    } else if (outcome.action === 'kept') {
      setSendError(`对账：找到原记录 ${outcome.recordId}，状态 ${outcome.recordState}；保持锁，等待终态。`);
    } else if (outcome.action === 'ready-clear-retry') {
      setSendError(`对账：找到原记录 ${outcome.recordId}，状态 ${outcome.recordState}；草稿尚未清空，可显式重试本地清空。`);
    } else {
      setSendError('未找到匹配原记录（按 kind/target/业务ID/文本 分页检索）；保持未确认与锁，绝不自动补发。');
    }
  }

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
    const rec = await findHostAdmissionRecord();
    if (!mountedRef.current) return;
    setTurnAdmission(rec ? readHostQueuedReceipt(rec)?.admission ?? null : null);
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
        botId: rec.botId, requestId: rec.requestId, text: rec.text,
      });
      if (!mountedRef.current) return;
      const nextAdmission = readTurnAdmission((receipt as { admission?: unknown }).admission);
      setTurnAdmission(nextAdmission);
      setSendError(nextAdmission && nextAdmission.phase !== 'failed'
        ? '已重新受理：' + TURN_ADMISSION_LABELS[nextAdmission.phase]
        : '已重新提交准入，等待 Host 受理状态更新。');
      // 本地 outbox 记录 receipt 仍带旧 admission：显式对账刷新一次（只读，不改远端状态）。
      try { await api.pending(current, 'pending_reconcile', { id: rec.id }); } catch { /* 对账失败不掩盖重试结果 */ }
    } catch (e) {
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

  const [live, setLive] = useState<BotLiveState | null>(null);
  const [liveLast, setLiveLast] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveEnded, setLiveEnded] = useState(false);
  const [watchTick, setWatchTick] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState(0);

  const [rawItems, setRawItems] = useState<AnyRawEntry[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const rawCursorRef = useRef<Record<string, unknown> | null>(null);
  const rawSessRef = useRef(sess);
  rawSessRef.current = sess;

  /**
   * 每轮任务完结（busy true→false）或观察结束时，沿升序游标逐页读完整可见历史
   * （与手机端 Host.tsx fetchBotHistoryPages 一致：首帧=最早页，继续翻页到尽头才包含最新条目），
   * 成功后整体替换本地可见历史——/clear 之后服务端已按 reset 裁剪，旧条目随之消失。
   * 单飞：busy 期间 token 级 update 不触发；turns 之间间隔靠飞行中标记+补跑标志合并。
   * 失败保留旧数据并置可见错误（聊天流顶部重试条），不静默丢弃。
   */
  const latestFlightRef = useRef<{ inFlight: boolean; dirty: boolean }>({ inFlight: false, dirty: false });
  const prevBusyRef = useRef(false);

  const loadRawLatest = useCallback(async () => {
    if (!identity || !api.transportConnected) return;
    if (latestFlightRef.current.inFlight) {
      latestFlightRef.current.dirty = true;
      return;
    }
    latestFlightRef.current.inFlight = true;
    const localSess = rawSessRef.current;
    try {
      const all: AnyRawEntry[] = [];
      let cursor: Record<string, unknown> | null = null;
      for (;;) {
        const page: Awaited<ReturnType<typeof readHistoryPage<AnyRawEntry>>> = await readHistoryPage<AnyRawEntry>(async (c, limit, chunked) => {
          if (rawSessRef.current !== localSess) return null;
          return api.call(identity, 'history', { botId: bot.botId, limit, cursor: c, ...(chunked ? { chunked: true } : {}) });
        }, cursor, 200);
        if (!page || rawSessRef.current !== localSess) return;
        const items = page.items;
        if (items.length === 0) break;
        all.push(...items);
        if (!page.nextCursor || typeof page.nextCursor !== 'object' || Array.isArray(page.nextCursor)) break;
        cursor = page.nextCursor;
      }
      if (rawSessRef.current !== localSess) return;
      // 完整可见历史整体替换：/clear 后 reset 之前的条目不再回归，不再依赖截断的 live 窗口。
      setRawItems(all);
      rawCursorRef.current = null;
      setRawError(null);
    } catch (e) {
      // 失败保留旧数据：重试按钮在聊天流顶部可见，下一次完结/重连也会再补跑。
      if (rawSessRef.current === localSess) {
        setRawError(tErr(e));
        reportUnlessTargetOffline(api, e);
      }
    } finally {
      latestFlightRef.current.inFlight = false;
      if (latestFlightRef.current.dirty && rawSessRef.current === localSess) {
        latestFlightRef.current.dirty = false;
        void loadRawLatest();
      }
    }
  }, [api, bot.botId, identity]);

  /**
   * 历史只读路径只有一条：无论首次进入、重连、重试或 busy 下降沿，都复用 loadRawLatest
   * 的完整分页单飞读取；这里只保留 loading 标记，失败错误由 loadRawLatest 自身置位。
   */
  const loadRaw = useCallback(async () => {
    if (!identity || !api.transportConnected) return;
    setRawLoading(true);
    try {
      await loadRawLatest();
    } finally {
      setRawLoading(false);
    }
  }, [api, identity, loadRawLatest]);

  // busy true→false 下降沿触发合并刷新；live.busy 首帧为 true 也等下一轮完结。
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    const busy = Boolean(live?.busy);
    prevBusyRef.current = busy;
    if (wasBusy && !busy) void loadRawLatest();
  }, [live?.busy, loadRawLatest]);

  useEffect(() => {
    // 离线/页面不可见（远端页切回本机）不发 observe：保留最后读取的 live 数据，重连后被动重建。
    if (!identity || !api.transportConnected || !pageActive) return;
    const localSess = sess;
    let disposed = false;
    let handle: { close(): Promise<void> } | null = null;
    void (async () => {
      if (disposed) return;
      setLive(null);
      setLiveError(null);
      setLiveEnded(false);
      setLiveLast(null);
      try {
        const h = api.observe(identity, { kind: 'primary', botId: bot.botId }, (ev) => {
          if (disposed) return;
          if (sessionKey(api.identity) !== localSess) return;
          if ('error' in ev) {
            const err = ev as Extract<DesktopObservationEvent, { error: unknown }>;
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
            setLive(f.state);
            // 快照帧可能带整字段 turnAdmission；缺省/形状非法一律清空显示。
            setTurnAdmission(readTurnAdmission((f.state as { turnAdmission?: unknown }).turnAdmission));
            onLiveActivityRef.current?.();
          } else {
            const changes = (f as { changes?: Partial<BotLiveState> }).changes;
            if (changes && 'turnAdmission' in changes) {
              setTurnAdmission(readTurnAdmission((changes as { turnAdmission?: unknown }).turnAdmission));
            }
            if (changes) {
              setLive((prev) => (prev ? { ...prev, ...changes } : prev));
              if ('history' in changes || 'busy' in changes || 'generation' in changes) {
                onLiveActivityRef.current?.();
              }
            }
          }
        });
        h.ready.catch((e) => {
          if (!disposed) {
            setLiveError('观察建立失败：' + tErr(e));
            setLiveEnded(true);
          }
        });
        handle = h;
      } catch (e) {
        if (!disposed) {
          setLiveError(tErr(e));
          setLiveEnded(true);
        }
      }
    })();
    return () => {
      disposed = true;
      if (handle) void handle.close().catch(() => {});
    };
  }, [api, sess, bot.botId, watchTick, online, pageActive, loadRawLatest]);

  async function stopTask() {
    if (!identity || stopping || !api.transportConnected) return;
    setStopping(true);
    try {
      await api.call(identity, 'abort', { botId: bot.botId });
    } catch (e) {
      setLiveError('停止失败：' + tErr(e));
      reportUnlessTargetOffline(api, e);
    } finally {
      if (mountedRef.current) setStopping(false);
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
    isArchived || sendState === 'sending' || slashBusy !== null || lockedRef.current || drafts.busy || !!drafts.attempt;

  // 统一口径只在这里计算一次传给 ChatTranscript：Host activity 为准；
  // 本地发送乐观只在 Host 未受理（idle/stopped）时叠加 queued；
  // abort 进行中本地投影 stopping（Host 的 stopping/interrupting 优先）。
  const liveActivity = resolveBotActivity(live);
  const sendingActivity: BotActivity | null =
    sendState === 'sending' &&
    slashBusy === null &&
    (liveActivity.phase === 'idle' || liveActivity.phase === 'stopped')
      ? {
          phase: 'queued', source: 'primary', scopeId: null, requestId: null, startedAt: null,
          webhookStopPending: liveActivity.webhookStopPending,
        }
      : null;
  const activity: BotActivity =
    stopping && liveActivity.phase !== 'stopping' && liveActivity.phase !== 'interrupting'
      ? { ...liveActivity, phase: 'stopping' }
      : sendingActivity ?? liveActivity;
  const liveBusy = isBotActivityBusy(activity);
  const canStop = canStopBotActivity(activity);
  // 停止独立门禁：只关联在线/归档/停止进行中，不被发送、草稿锁或附件上传禁用。
  const stopDisabled = !online || isArchived || stopping;
  void avatarVersion; // 头像保存后 bump：重新计算 key 下各 GrokBotAvatar preset

  const statusText = !online
    ? `目标 ${deviceName}（${bot.role}）离线：显示最后读取的数据`
    : liveError
      ? liveError
      : liveEnded
        ? '观察已结束（不断连 Agent）'
        : live
          ? botActivityText(activity, t)
          : '正在建立观察…';

  function openInspector(tab: InspectorTab) {
    setInspectorTab((cur) => (cur === tab ? null : tab));
  }

  return (
    <div className="chat-stage" ref={stageRef}>
      <div className="chat-column">
      <header className="chat-header">
        <button
          type="button"
          className="chat-header-pill"
          onClick={() => openInspector('profile')}
          title="打开 Bot 工作台（Ctrl+.）"
        >
          <GrokBotAvatar
            botKey={botAvatarKey(bot)}
            roleName={bot.role}
            isPrimary={isPrimary && !isArchived}
            starBadge={isPrimary && !isArchived}
            platformBadge={devicePlatform}
            busy={liveBusy}
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
          <button
            type="button"
            className={`secondary-button chat-action-pill${inspectorTab === 'settings' ? ' active' : ''}`}
            onClick={() => openInspector('settings')}
            title="人设与能力（SOUL / 模型 / 插件）"
          >
            人设与能力
          </button>
          {canStop || stopping ? (
            <button
              type="button"
              className={`secondary-button chat-action-pill stop-pill${stopping ? ' is-stopping' : ''}`}
              onClick={() => void stopTask()}
              disabled={stopDisabled}
              title="停止此 Bot（取消排队与进行中的工作）"
              aria-label="停止此 Bot"
            >
              <Square size={14} /> {stopping ? '正在停止…' : '停止此 Bot'}
            </button>
          ) : null}
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
                    <MessageSquare size={14} /> 查看私聊
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
                    onClick={() => { setMoreMenuOpen(false); void handleArchive(); }}
                  >
                    <Archive size={14} /> {manageAction === 'archive' ? '归档中…' : '归档智能体'}
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
                  <History size={14} /> 原始历史与对账
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={disabled}
                  onClick={() => { setMoreMenuOpen(false); drafts.editText('/clear'); }}
                >
                  <Eraser size={14} /> /clear 清空当前对话
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={disabled}
                  onClick={() => { setMoreMenuOpen(false); drafts.editText('/compact'); }}
                >
                  <Shrink size={14} /> /compact 压缩上下文
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

      {confirmDelete && !isPrimary ? (
        <div className="confirm-delete-banner" role="alert">
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
              onClick={() => setConfirmDelete(false)}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {manageError ? (
        <div className="error-banner" role="alert">
          {manageError}
          <button type="button" onClick={() => setManageError(null)}>关闭</button>
        </div>
      ) : null}

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
      {!online ? (
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
        activity={activity}
        avatarKey={botAvatarKey(bot)}
        devicePlatform={devicePlatform}
        search={chatSearch}
        archived={isArchived}
        onSubmitQuestionnaire={submitQuestionnaire}
        attachmentFetcher={attachmentFetcher}
        loading={rawLoading}
        error={online ? (rawError || liveError) : null}
        hasMore={false}
        onLoadMore={() => void loadRaw()}
        onRetry={() => {
          setLiveError(null);
          setWatchTick((t) => t + 1);
          void loadRaw();
        }}
        emptyActions={
          <>
            <button type="button" className="secondary-button" onClick={() => openInspector('profile')}>
              <Palette size={15} aria-hidden="true" /> 定制形象与资料
            </button>
            <button type="button" className="secondary-button" onClick={() => openInspector('settings')}>
              <Sparkles size={15} aria-hidden="true" /> 配置灵魂与模型
            </button>
            <button type="button" className="secondary-button" onClick={() => openInspector('shower')}>
              <Monitor size={15} aria-hidden="true" /> 打开虚拟桌面
            </button>
          </>
        }
      />

      <Composer
        text={drafts.text}
        onChangeText={onChangeText}
        files={drafts.files}
        onAddFile={addFile}
        onRemoveFile={removeFile}
        attachments={drafts.attachments}
        onAddAttachment={addAttachment}
        onRemoveAttachment={removeAttachment}
        attachmentFetcher={attachmentFetcher}
        onPickImage={pickImage}
        canPick={!isArchived && identity?.kind === 'local'}
        onPick={pickFile}
        draftError={drafts.error}
        draftHint={isArchived ? '此 Bot 已归档，当前为只读模式，恢复后可继续发送消息。' : null}
        draftConflict={drafts.conflict}
        sendState={sendState}
        sendError={sendError}
        sendNotice={sendNotice}
        onSend={handleSend}
        canSend={
          !isArchived &&
          !!identity &&
          !!drafts.key &&
          (drafts.text.trim().length > 0 || drafts.attachments.length > 0) &&
          !drafts.attempt &&
          !drafts.savePaused &&
          !imageUploading
        }
        disabled={disabled}
        onRetryDraft={drafts.retrySave}
        attempt={drafts.attempt ? {
          ...drafts.attempt,
          businessId: drafts.attempt.input.kind === 'primary' ? drafts.attempt.input.requestId : drafts.attempt.input.messageId,
        } : null}
        recOutcome={recOutcome}
        onReconcile={queryPending}
        onReleaseNotSent={releaseNotSent}
        onRetryClearVerified={retryClearVerified}
        onAdoptNewerDraft={adoptNewerDraft}
        turnAdmission={turnAdmission}
        onRetryTurnAdmission={() => void retryTurnAdmission()}
        onInsertSlash={(cmd) => drafts.editText(cmd)}
      />
      </div>

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
            <Dialog.Title className="sr-only">Bot 工作台</Dialog.Title>
            <div className="inspector-head">
              <div className="pill-tabs" role="tablist" aria-label="工作台页签">
                {(
                  [
                    { key: 'profile', label: '资料' },
                    { key: 'settings', label: '设置' },
                    { key: 'raw', label: '原始历史' },
                    { key: 'shower', label: '桌面' },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={inspectorTab === t.key}
                    className={inspectorTab === t.key ? 'active' : ''}
                    onClick={() => setInspectorTab(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
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
            <div className="inspector-body">
              {inspectorTab === 'profile' ? (
                <div className="inspector-section">
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
                  <BotProfile api={api} centerApi={centerApi} bot={bot} onSaved={onProfileSaved} />
                  <div className="inspector-meta-card">
                    <div className="metadata">设备：{deviceName}（{bot.deviceId}）</div>
                    <div className="metadata">botId：{bot.botId}</div>
                    <div className="metadata">cwd：{bot.cwd}</div>
                  </div>
                  <div className="inspector-lifecycle">
                    <div className="inspector-section-title">生命周期</div>
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
                          onClick={() => void handleArchive()}
                        >
                          {manageAction === 'archive' ? '归档中…' : '归档智能体'}
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
                        disabled={!online || manageBusy || isPrimary}
                        onClick={() => setConfirmDelete(true)}
                      >
                        永久删除智能体
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
              {inspectorTab === 'settings' ? (
                <BotSettings api={api} botId={bot.botId} open onOpenChange={() => { /* 页签由外层管理，内部不再渲染关闭 UI */ }} />
              ) : null}
              {inspectorTab === 'raw' ? (
                <RawHistoryPane
                  items={rawItems}
                  loading={rawLoading}
                  error={rawError}
                  onLoadMore={() => void loadRaw()}
                  hasMore={false}
                  onRetry={() => void loadRaw()}
                  offline={!online}
                />
              ) : null}
              {inspectorTab === 'shower' ? (
                <ShowerPreview
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
}: {
  api: DesktopPanelApi;
  currentDeviceId: string;
  pageActive?: boolean;
  /** Scopes「打开 Bot」导航：按稳定 botId + deviceId 选中 Bot（同名 Bot 靠 ID 区分）；
   *  initialDeviceId 缺省时只在当前目录中按 botId 匹配。 */
  initialBotId?: string;
  initialDeviceId?: string;
  onArchiveBridge?: (bridge: BotChatsArchiveBridge | null) => void;
}) {
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
  const profileKey = identity ? `${identity.profileId}|${identity.kind}` : '';
  const profileRef = useRef(profileKey);
  const initialCache = useMemo(() => readDirectoryCache(profileKey), [profileKey]);
  const {
    pinnedKeys,
    isPinned,
    togglePin,
    reorderPins,
    removePin,
    error: pinsError,
  } = useChatPins(profileKey || 'default');

  const [bots, setBots] = useState<BotDirectoryEntry[]>(() => initialCache?.bots ?? []);
  const [devices, setDevices] = useState<DevicesDirectoryItem[]>(() => initialCache?.devices ?? []);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<boolean>(() => Boolean(initialCache));
  const [selected, setSelected] = useState<{ deviceId: string; botId: string } | null>(null);
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
  const [confirmDeleteBot, setConfirmDeleteBot] = useState<BotDirectoryEntry | null>(null);
  const [deletingBotKey, setDeletingBotKey] = useState<string | null>(null);
  const [deleteBotError, setDeleteBotError] = useState<string | null>(null);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<ConfirmDeleteGroupState | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const refreshQueued = useRef(false);
  const inFlight = useRef(false);
  const seq = useRef(0);
  const sessionRef = useRef(sess);
  sessionRef.current = sess;
  const lastLiveRefreshRef = useRef(0);

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
    if (loaded && profileKey) {
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
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        setListCollapsed(false);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if (k === 'b') {
        e.preventDefault();
        setListCollapsed((v) => !v);
      } else if (k === 'f') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('botchats:chat-search'));
      } else if (e.key === '.') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('botchats:toggle-inspector'));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    const onlineByDevice = new Map(devices.map((d) => [d.deviceId, d.online]));
    const nameByDevice = new Map(devices.map((d) => [d.deviceId, d.displayName || '未命名设备']));
    const hostDeviceIds = [...new Set(bots.map((b) => b.deviceId))];
    return hostDeviceIds.map((deviceId) => ({
      key: deviceId,
      label: nameByDevice.get(deviceId) ?? deviceId,
      api: targetApi(api, deviceId, onlineByDevice.get(deviceId) ?? false),
      identity: api.identityForTarget(deviceId),
      bots,
    }));
  }, [api, sess, devices, bots]);
  const {
    items: groupItems,
    loading: groupsLoading,
    error: groupsError,
    refresh: refreshGroups,
  } = useScopeConversations(scopeSources, pageActive, 'room');

  /** 群聊实际所在 Host：identity.targetDeviceId 是稳定字符串，不依赖 targetApi 对象引用。 */
  function groupSourceOf(g: (typeof groupItems)[number]) {
    const deviceId = g.identity.targetDeviceId;
    const label = devices.find((d) => d.deviceId === deviceId)?.displayName || '未知设备';
    return { deviceId, label };
  }

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

  const selectedBot = selected
    ? bots.find((b) => b.deviceId === selected.deviceId && b.botId === selected.botId) ?? null
    : null;
  const scopedApi = useMemo(
    () =>
      identity && selectedBot
        ? targetApi(api, selectedBot.deviceId, selectedBot.online)
        : null,
    [api, sess, selectedBot?.deviceId, selectedBot?.online],
  );
  /** 子视图 api 按当前 api + sess（含 generation）+ 在线布尔重建：同 profile 重连后
   *  identity 代际更新、设备上下线同步反映；不依赖 devices 数组引用（每轮目录刷新
   *  都换引用，依赖它会反复给 Scopes 传新 api 对象导致历史清空/重置）。 */
  const stageOnline = stage ? deviceOnlineOf(stage.deviceId) : false;
  const stageApi = useMemo(
    () => (stage ? targetApi(api, stage.deviceId, stageOnline) : null),
    [api, sess, stage?.deviceId, stageOnline],
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
    if (!initialBotId) {
      initialNavRef.current = null;
      return;
    }
    const key = `${initialDeviceId ?? ''}:${initialBotId}`;
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
  }, [initialBotId, initialDeviceId, bots]);

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
      try {
        const botApi = targetApi(api, targetBot.deviceId, Boolean(targetBot.online && api.transportConnected));
        if (!botApi.identity || !botApi.transportConnected) {
          throw new Error('目标设备离线或未连接');
        }
        await botApi.call(botApi.identity, 'deleteBot', { botId: targetBot.botId });
        if (sessionRef.current !== localSess) return;
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
        triggerLoadBots();
        refreshGroups();
      } catch (e) {
        if (sessionRef.current === localSess) {
          reportUnlessTargetOffline(api, e);
        }
        throw e;
      }
    },
    [api, identity, removePin, triggerLoadBots, refreshGroups],
  );

  const openArchivedBotHistory = useCallback((targetBot: BotDirectoryEntry) => {
    setDeviceFilter('all');
    setQuery('');
    setRoomSettingsOpen(false);
    setStage(null);
    setSelected({ deviceId: targetBot.deviceId, botId: targetBot.botId });
  }, []);

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
    ],
  );

  useEffect(() => {
    onArchiveBridge?.(archiveBridge);
  }, [onArchiveBridge, archiveBridge]);

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

  function shortDeviceName(name: string): string {
    const trimmed = name.trim();
    return trimmed.length > 8 ? `${trimmed.slice(0, 7).trimEnd()}…` : trimmed;
  }

  function renderGroupRow(g: (typeof groupRows)[number], pinned: boolean) {
    const source = groupSourceOf(g);
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
        pinned={pinned}
        badge="群聊"
        meta={shortDeviceName(source.label)}
        avatar={
          <ConversationGroupAvatar members={g.scope.scope.members} bots={bots} size={46} />
        }
        onOpen={() => {
          setRoomSettingsOpen(false);
          setStage({
            kind: 'scope',
            scopeId,
            deviceId: source.deviceId,
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
    const isPrimaryActive = Boolean(b.isPrimary && !b.archivedAt);
    const activityIso = b.lastActivityAt || b.createdAt;
    const rowNode = (
      <ConversationRow
        className={`hub-bot-row${isSelected ? ' selected' : ''}${!isBotOnline ? ' offline' : ''}`}
        title={b.role}
        preview={plainPreview(b.lastPreview)}
        timestamp={activityIso}
        selected={isSelected}
        pinned={pinned}
        meta={`${shortDeviceName(deviceNameOf(b.deviceId))} · ${isBotOnline ? '在线' : '离线'}`}
        avatar={
          <GrokBotAvatar
            botKey={botAvatarKey(b)}
            roleName={b.role}
            isPrimary={isPrimaryActive}
            starBadge={isPrimaryActive}
            platformBadge={b.platform || 'host'}
            busy={false}
            size={46}
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
      const source = groupSourceOf(g);
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
              deviceId: source.deviceId,
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
      label: '查看私聊',
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
          void archiveBotEntry(b).catch(() => {});
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
  }, [menu, isPinned, online, resolveRoomApi, togglePin, archiveBotEntry, devices, currentDeviceId]);

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
                size={44}
              />
              <span className="hub-hero-info">
                <span className="hub-hero-name">{b.role}</span>
                <span className={`hub-hero-node${b.online && online ? '' : ' offline'}`}>
                  {b.online && online ? deviceNameOf(b.deviceId) : `${deviceNameOf(b.deviceId)} · 离线`}
                </span>
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
          <div className="hub-device-chips" role="tablist" aria-label="设备筛选">
            <button
              type="button"
              className={deviceFilter === 'all' ? 'chip active' : 'chip'}
              onClick={() => setDeviceFilter('all')}
            >
              全部
            </button>
            {devices.map((d) => (
              <button
                key={d.deviceId}
                type="button"
                className={deviceFilter === d.deviceId ? 'chip active' : 'chip'}
                onClick={() => setDeviceFilter(d.deviceId)}
              >
                {d.displayName || '未命名设备'}
              </button>
            ))}
          </div>
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
        {!online ? <div className="status">离线：显示最后读取的 Bot 列表。</div> : null}

        <div className="hub-list-scroll">
          {loading && !loaded ? (
            <div className="status">加载中…</div>
          ) : !loaded ? (
            <div className="status">目录尚未读取。</div>
          ) : primaryBots.length === 0 && regularBots.length === 0 && groupRows.length === 0 && !botsError ? (
            <div className="empty-state">
              {query || deviceFilter !== 'all' ? '没有匹配的智能体或群聊。' : '暂无 Bot，点击“新建 Bot”创建。'}
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
              setShowCreate(true);
              if (missingPrimaryDevices.length > 0) {
                setCreateTargetDeviceId(missingPrimaryDevices[0].deviceId);
              }
            }}
            disabled={!identity}
          >
            <Plus size={15} /> 新建智能体
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              triggerLoadBots();
              refreshGroups();
            }}
            disabled={!online || loading}
            aria-label="刷新列表"
            title="刷新列表"
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </aside>

      <section className="main-stage">
        {stage?.kind === 'dm' && stageApi ? (
          <div className="scope-main-stage">
            <Scopes
              key={`dm:${sess}:${stage.member.deviceId}:${stage.member.botId}`}
              api={stageApi}
              pageActive={pageActive}
              readOnly
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
              key={`scope:${sess}:${stage.deviceId}:${stage.scopeId}`}
              api={stageApi}
              pageActive={pageActive}
              scopeKind="room"
              detailOnly
              initialScopeId={stage.scopeId}
              resolveRoomApi={resolveRoomApi}
              memberCandidates={scopeMemberCandidates}
              settingsOpen={roomSettingsOpen}
              onSettingsOpenChange={setRoomSettingsOpen}
              onDeleted={() => {
                removePin(roomPinKey(stage.scopeId));
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
            key={`${sess}:${selectedBot.deviceId}:${selectedBot.botId}`}
            api={scopedApi}
            centerApi={api}
            bot={selectedBot}
            deviceName={selectedDeviceName}
            devicePlatform={selectedDevicePlatform}
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
              removePin(botPinKey(targetDeviceId, deletedBotId));
              setSelected(null);
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
            pageActive={pageActive && !stage}
          />
          </div>
        ) : null}
        {!stage && !(scopedApi && selectedBot) ? (
          <div className="empty-state stage-empty">
            <span className="title">选择左侧智能体开始对话</span>
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
                  确定要解散并删除群聊「{confirmDeleteGroup.title}」吗？解散后所有设备上的该群聊及历史消息都将被永久删除，此操作不可撤销。
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
