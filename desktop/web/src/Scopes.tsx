import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  MessageSquare,
  Plus,
  RefreshCw,
  Reply,
  SendHorizontal,
  Users,
  X,
} from 'lucide-react';
import type { DesktopViewApi } from './types';
import { isScopeWritableApi } from './scope-api';
import type { RoomApiResolver, ScopeReadApi } from './scope-api';
import type {
  BotRecord,
  MessageCursor,
  MessageHistoryCursor,
  MessageMember,
  MessageHistoryPage,
  PendingEnqueueInput,
  PendingRecord,
  ScopeInfo,
  StoredMessage,
} from '../../../host-core/index.js';
import { useDrafts } from './drafts';
import {
  ConversationChatHeader,
  ConversationGroupAvatar,
  ConversationMessage,
  ConversationRow,
  ConversationTimeDivider,
  conversationMemberName,
  conversationTitle,
  useScopeConversations,
} from '../../../web/src/gbot-ui';
import type {
  ConversationBot,
  ScopeConversationSource,
} from '../../../web/src/gbot-ui';
import {
  GroupSettings,
  isNotSent,
  isScopeDeleted,
  memberAvatar,
  scopeDeviceName,
  sessionKey,
} from './GroupSettings';
import type { ScopeBotInfo } from './GroupSettings';
import './Scopes.css';
import './scope-ui.css';

export type { ScopeBotInfo } from './GroupSettings';

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * 消息作者可读名：bot 作者用可信 sourceDeviceId + botId 匹配已知目录，
 * user 作者回退通用“我”。绝不输出 botId/deviceId/scopeId。
 */
function authorName(m: StoredMessage, bots: readonly ConversationBot[]): string {
  const author = m.message.author;
  if (author.kind !== 'bot') return '我';
  return conversationMemberName({ deviceId: m.message.sourceDeviceId, botId: author.botId }, bots);
}

/** 历史分页参数：分页 lane 确认的 ScopeHistoryOptions 形状（order/tailCursor）；ascending 保持旧契约。 */
type ScopeHistoryParams = {
  scopeId: string;
  limit: number;
  cursor?: MessageHistoryPage['nextCursor'];
  order?: 'ascending' | 'descending';
};
/** 分页 lane 已确认 tailCursor 每页必有（空页为 null）；本 worktree 的 d.ts 未含该字段，经此读取保持向前兼容。 */
type ScopeHistoryPage = MessageHistoryPage & { tailCursor?: MessageCursor | null };
function pageTail(page: MessageHistoryPage): MessageCursor | null {
  return (page as ScopeHistoryPage).tailCursor ?? null;
}

/** 历史条目按 messageId 去重追加（初始倒序页、prepend 旧页、poll 增量共用）。 */
function dedupeAppend(prev: StoredMessage[], incoming: StoredMessage[]): StoredMessage[] {
  const seen = new Set(prev.map((m) => m.message.messageId));
  const added = incoming.filter((m) => !seen.has(m.message.messageId));
  return added.length === 0 ? prev : [...prev, ...added];
}

/**
 * knownBots（宿主目录，含归档/远端）与 api.listBots（实时）按 deviceId+botId 合并：
 * 实时结果同身份优先，同时保留目录提供的自然设备名、平台与描述信息。
 */
function mergeKnownBots(listed: BotRecord[], known: readonly ScopeBotInfo[] | undefined): ScopeBotInfo[] {
  const map = new Map<string, ScopeBotInfo>();
  for (const b of known ?? []) map.set(`${b.deviceId}:${b.botId}`, { ...b });
  for (const b of listed) {
    const prev = map.get(`${b.deviceId}:${b.botId}`);
    map.set(`${b.deviceId}:${b.botId}`, {
      ...prev,
      deviceId: b.deviceId,
      botId: b.botId,
      role: b.role,
      isPrimary: b.isPrimary,
      description: b.description || prev?.description,
    });
  }
  return [...map.values()];
}

type RoomSendRecordsTarget = { deviceId: string; scopeId: string; recordId?: string };

function RoomComposer({ api, scopeId, replyTo, onReplyTo, onAccepted, deviceName, onOpenSendRecords }: {
  api: DesktopViewApi;
  scopeId: string;
  replyTo: string | null;
  onReplyTo: (id: string | null) => void;
  /** 仅在“确定受理”后触发只读历史刷新；刷新失败不得改变发送结果。 */
  onAccepted: () => void;
  deviceName?: string;
  onOpenSendRecords?: (target: RoomSendRecordsTarget) => void;
}) {
  const identity = api.identity;
  const desktop = deviceName !== undefined;
  const recordsLabel = desktop ? '发送记录' : '待发送面板';
  const draftTarget = useMemo(() => ({ kind: 'room' as const, id: scopeId }), [scopeId]);
  const drafts = useDrafts({ api, identity, target: draftTarget });
  const [sendState, setSendState] = useState<'idle' | 'sending'>('idle');
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastRecord, setLastRecord] = useState<{ deviceId: string; id: string; accepted: boolean } | null>(null);
  const [recOutcome, setRecOutcome] = useState<{ action: string; found: boolean; recordId: string | null; recordState: string | null } | null>(null);
  const lockedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  function onChangeText(v: string) {
    drafts.editText(v);
    if (sendError) setSendError(null);
    if (lastRecord?.accepted) setLastRecord(null);
  }

  function setReply(id: string | null) {
    onReplyTo(id);
    if (sendError) setSendError(null);
  }

  async function handleSend() {
    if (!identity || sendState !== 'idle' || lockedRef.current) return;
    const msg = drafts.text.trim();
    if (!msg) return;
    const messageId = crypto.randomUUID();
    const input: PendingEnqueueInput = {
      kind: 'room',
      targetDeviceId: identity.targetDeviceId,
      scopeId,
      messageId,
      text: msg,
      replyTo: replyTo,
    };
    const started = drafts.beginSend(input);
    if (!started) return;
    lockedRef.current = true;
    setSendState('sending');
    setSendError(null);
    setRecOutcome(null);
    setLastRecord(null);
    await drafts.waitQuiet(started.handle);
    // 只发送冻结副本：await 后不重组 replyTo/业务 ID。
    const frozen = started.attempt.input;
    try {
      let rec: PendingRecord | null = null;
      try {
        rec = await api.pending(identity, 'pending_enqueue', { input: frozen });
      } catch (e) {
        api.reportError(e);
        // 只有本阶段明确 not-sent（无队列记录）才可声称未入队。
        if (isNotSent(e)) {
          const errMsg = '发送未入队。原消息未产生队列记录，可恢复编辑后重试。';
          drafts.markNotSent(started.handle, errMsg);
          setSendError(errMsg);
        } else {
          const errMsg = '发送结果未确认。已冻结原发送记录，不会自动补发；请查询发送状态确认。';
          drafts.markUnconfirmed(started.handle);
          setSendError(errMsg);
        }
        return;
      }
      if (!rec) return;
      drafts.setPending(started.handle, rec.id);
      const pendingId = rec.id;
      if (desktop && mountedRef.current) setLastRecord({ deviceId: rec.targetDeviceId, id: pendingId, accepted: false });
      const cleared = await drafts.confirmCleared(started.handle);
      if (cleared !== 'cleared') {
        const errMsg = cleared === 'conflict'
          ? '草稿尚未清空：磁盘草稿已被更新。原发送记录保留且未发送；请查看新版草稿并选择“保留新版草稿，结束旧尝试”，不会自动清空或补发。'
          : `草稿尚未清空：消息已入队但未远程发送，请在${recordsLabel}中处理。`;
        drafts.markFailed(started.handle, errMsg);
        setSendError(errMsg);
        return;
      }
      if (mountedRef.current) onReplyTo(null);
      if (!api.transportConnected || (desktop && sessionKey(api.identity) !== sessionKey(identity))) {
        drafts.finishSend(started.handle);
        setSendError(desktop
          ? `消息已入队。${deviceName}可用后，请从发送记录继续发送。`
          : '离线：消息已入队，连接后请在待发送面板显式发送。');
        return;
      }
      try {
        const sent = await api.pending(identity, 'pending_send', { id: pendingId });
        reportSendRecord(started.handle, sent);
      } catch (e) {
        // 回执丢失/超时/未知：已入队，保留原 ID 锁，绝不标未入队。
        api.reportError(e);
        drafts.markUnconfirmed(started.handle);
        setSendError('发送回执未确认。消息已入队，不会自动补发；请查询发送状态确认。');
      }
    } finally {
      lockedRef.current = false;
      setSendState('idle');
    }
  }

  function reportSendRecord(handle: { key: string; attemptId: string }, rec: PendingRecord) {
    if (desktop && mountedRef.current) setLastRecord({ deviceId: rec.targetDeviceId, id: rec.id, accepted: rec.state === 'accepted' });
    if (rec.state === 'accepted') {
      drafts.finishSend(handle);
      // 受理只说明已受理；完成与否以 live/原回执为准，界面不断言。
      // 已受理是成功路径：清错误条并刷新只读历史，不用 error-banner 展示。
      setSendError(null);
      if (mountedRef.current) onAccepted();
    } else if (rec.state === 'rejected') {
      // 确定终态：本地 attempt 结束，原记录保留在待发送面板
      drafts.finishSend(handle);
      setSendError(`发送被拒。可查看${recordsLabel}了解详情。`);
    } else if (rec.state === 'unconfirmed') {
      const errMsg = desktop ? '发送结果未确认，可在发送记录核对。' : '发送结果未确认，请等待待发送面板对账。';
      drafts.markUnconfirmed(handle);
      setSendError(errMsg);
    } else {
      drafts.finishSend(handle);
      setSendError('消息已入队，等待发送结果。');
    }
  }

  async function queryPending() {
    if (!identity || !drafts.attempt || !drafts.key) return;
    const handle = { key: drafts.key, attemptId: drafts.attempt.id };
    const deviceId = drafts.attempt.owner.targetDeviceId;
    const outcome = await drafts.reconcile(handle);
    if (!mountedRef.current) return;
    setRecOutcome(outcome);
    if (desktop && outcome.recordId) {
      setLastRecord({ deviceId, id: outcome.recordId, accepted: outcome.recordState === 'accepted' });
    }
    if (outcome.action === 'finished') {
      setSendError(desktop && outcome.recordState === 'accepted' ? null : '发送状态已确定，本地发送尝试已结束。');
      // 只读对账也确认受理时刷新消息；读失败只进 histError。
      if (outcome.recordState === 'accepted') onAccepted();
    } else if (outcome.action === 'kept') {
      setSendError('已找到原发送记录，仍在等待终态。');
    } else if (outcome.action === 'ready-clear-retry') {
      setSendError('已确认原发送记录，可重试清空本地草稿。');
    } else {
      setSendError('未找到匹配的发送记录；保持未确认状态，不会自动补发。');
    }
  }

  async function retryClearVerified() {
    if (!identity || !drafts.attempt || !drafts.key) return;
    const handle = { key: drafts.key, attemptId: drafts.attempt.id };
    const r = await drafts.retryClearAfterVerify(handle);
    if (r === 'cleared') {
      setRecOutcome(null);
      setSendError(`本地草稿已清空，可从${recordsLabel}继续发送。`);
    } else if (r === 'conflict') {
      setSendError('草稿尚未清空：磁盘草稿已被更新；请查看新版草稿并选择“保留新版草稿，结束旧尝试”。');
    } else {
      setSendError('重试本地清空失败，仍保持当前状态。');
    }
  }

  function adoptNewerDraft() {
    if (!drafts.attempt || !drafts.key) return;
    const handle = { key: drafts.key, attemptId: drafts.attempt.id };
    const r = drafts.adoptNewerDraftAndFinish(handle);
    if (r.ok) {
      setRecOutcome(null);
      setSendError(`已保留新版草稿。旧消息尚未发送，可在${recordsLabel}查看。`);
    } else {
      setSendError(r.error ?? '无法采用新版草稿');
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
      setSendError(r.error ?? '无法恢复编辑');
    }
  }

  const disabled = sendState === 'sending' || lockedRef.current || drafts.busy || !!drafts.attempt;
  const canSend = !disabled && !!identity && !!drafts.key && !!drafts.text.trim() && !drafts.savePaused;
  const attempt = drafts.attempt;
  const recordTarget: RoomSendRecordsTarget | null = attempt
    ? attempt.pendingId || attempt.phase === 'unconfirmed'
      ? { deviceId: attempt.owner.targetDeviceId, scopeId, recordId: attempt.pendingId ?? undefined }
      : null
    : lastRecord ? { deviceId: lastRecord.deviceId, scopeId, recordId: lastRecord.id } : null;
  const recordAction = onOpenSendRecords && recordTarget ? (
    <button type="button" className="scope-send-record-link" onClick={() => onOpenSendRecords(recordTarget)}>
      查看发送记录
    </button>
  ) : null;

  return (
    <div className="composer scope-composer">
      {drafts.error ? (
        <div className="error-banner" role="alert">
          草稿保存失败，本地输入已保留。
          <button type="button" onClick={drafts.retrySave}>重试保存</button>
        </div>
      ) : null}
      {drafts.conflict ? (
        <div className="status">
          磁盘上的新版草稿：{truncate(drafts.conflict.text, 160) || '（空文本）'}
          {drafts.conflict.files.length > 0 ? `（${drafts.conflict.files.length} 个文件引用）` : ''}
        </div>
      ) : null}
      {drafts.attempt ? (
        <div className="error-banner" role="alert" aria-live="polite">
          {drafts.attempt.phase === 'not-sent' ? (
            <>
              发送未入队。
              <button type="button" onClick={() => releaseNotSent()}>恢复编辑</button>
            </>
          ) : (
            <>
              正在确认发送状态，消息不会自动补发。
              {drafts.attempt.phase === 'cleared' || drafts.attempt.phase === 'failed' || drafts.attempt.phase === 'unconfirmed' ? (
                <button type="button" onClick={() => void queryPending()}>查询发送状态</button>
              ) : null}
              {drafts.conflict && recOutcome?.found ? (
                <button type="button" onClick={() => adoptNewerDraft()}>保留新版草稿，结束旧尝试</button>
              ) : null}
              {recOutcome?.action === 'ready-clear-retry' ? (
                <button type="button" onClick={() => void retryClearVerified()}>重试清空草稿</button>
              ) : null}
              {desktop && sendError ? <span>{sendError}</span> : null}
              {recordAction}
            </>
          )}
        </div>
      ) : null}
      {replyTo ? (
        <div className="message-replyto scope-reply-bar">
          <Reply size={13} />
          正在回复一条消息
          <button type="button" className="icon-button" onClick={() => setReply(null)} disabled={disabled} title="取消回复" aria-label="取消回复">
            <X size={13} />
          </button>
        </div>
      ) : null}
      <div className="scope-composer-row">
        <textarea
          className="composer-input scope-composer-input"
          value={drafts.text}
          onChange={(e) => onChangeText(e.target.value)}
          placeholder="给群聊发消息…（Enter 发送，Shift+Enter 换行）"
          rows={2}
          disabled={disabled}
          onKeyDown={(e) => {
            // 群聊 Enter 发送 / Shift+Enter 换行；IME 组合态安全放行。
            if (e.key !== 'Enter' || e.shiftKey) return;
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            void handleSend();
          }}
        />
        <button
          type="button"
          className="primary-button scope-send-btn"
          onClick={() => void handleSend()}
          disabled={!canSend}
          title="发送（Enter）"
        >
          <SendHorizontal size={15} />
          {sendState === 'sending' ? '发送中…' : '发送'}
        </button>
      </div>
      {desktop ? <div className="scope-composer-footnote">
        <span>{api.transportConnected ? '草稿保存在本机。' : `${deviceName}暂时不可用。草稿保存在本机。`}</span>
        {!attempt && (sendError || lastRecord?.accepted || recordAction) ? <span role="status">
          {sendError ?? (lastRecord?.accepted ? '消息已受理。' : '')}
          {recordAction}
        </span> : null}
      </div> : null}
      {!desktop && sendError ? <div className="error-banner" role="alert">{sendError}</div> : null}
      {desktop && attempt?.phase === 'not-sent' && sendError ? <div className="status" role="status">{sendError}</div> : null}
    </div>
  );
}

/**
 * 成员编辑：只能从已知 Bot 候选（本目标 Host listBots + 宿主目录）选择，
 * 列表显示姓名头像；不再手输 deviceId/botId。
 */
function MemberEditor({ current, candidates, names, onChange }: {
  current: MessageMember[];
  /** 可新增候选（宿主可传未归档子集）；归档过滤只影响新增，不隐藏现有成员。 */
  candidates: readonly ConversationBot[];
  /** 成员名字/头像目录：始终用 knownBots 合并全集（含已归档的现有成员）。 */
  names: readonly ConversationBot[];
  onChange: (members: MessageMember[]) => void;
}) {
  const choices = candidates.filter(
    (b) => !current.some((m) => m.deviceId === b.deviceId && m.botId === b.botId),
  );
  return (
    <div className="form-grid">
      {choices.length > 0 ? (
        <div className="field">
          <label>添加成员</label>
          <div className="member-quick-row">
            {choices.map((b) => (
              <button
                key={`${b.deviceId}:${b.botId}`}
                type="button"
                className="member-chip"
                onClick={() => onChange([...current, { deviceId: b.deviceId, botId: b.botId }])}
                title={`添加成员 ${b.role}`}
              >
                {memberAvatar(b, names, 22)}
                <span className="member-chip-name">{b.role}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <ul className="member-list">
        {current.map((m) => (
          <li key={`${m.deviceId}:${m.botId}`} className="member-row">
            <span className="member-row-avatar">{memberAvatar(m, names, 26)}</span>
            <span className="member-row-text">
              <span className="entity-title">{conversationMemberName(m, names)}</span>
            </span>
            <button
              type="button"
              className="icon-button"
              title={`移除成员 ${conversationMemberName(m, names)}`}
              aria-label={`移除成员 ${conversationMemberName(m, names)}`}
              onClick={() => onChange(current.filter((x) => !(x.deviceId === m.deviceId && x.botId === m.botId)))}
            >
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScopeDetail({
  api,
  variant,
  onOpenSendRecords,
  participant,
  scope,
  bots,
  onChanged,
  pageActive = true,
  canWrite,
  onBack,
  onOpenLink,
  resolveRoomApi,
  memberCandidates,
  onDeleted,
  onHistoryViewed,
  settingsOpen,
  onSettingsOpenChange,
}: {
  api: ScopeReadApi;
  variant: 'desktop' | 'mobile';
  onOpenSendRecords?: (target: RoomSendRecordsTarget) => void;
  participant?: MessageMember;
  scope: ScopeInfo;
  bots: readonly ScopeBotInfo[];
  onChanged: (s: ScopeInfo) => void;
  pageActive?: boolean;
  /** 完整写 API + !readOnly 才为 true；只读模式隐藏全部编辑/发送控件。 */
  canWrite: boolean;
  /** 头部返回：detailOnly 回宿主；受控 DM 内容页回列表（回调由父 Scopes 统一装配）。 */
  onBack?: () => void;
  /** Markdown 链接打开方式（桌面 Tauri 无 mobile 桥时传入）。 */
  onOpenLink?: (href: string) => void | Promise<unknown>;
  /** 群聊写端解析器：send/members 分别路由真实 DesktopViewApi；返回 null 表示写端未连接。 */
  resolveRoomApi?: RoomApiResolver;
  /** 新增成员候选（未归档 Bot）；缺省用 bots；现有成员名字始终走 bots。 */
  memberCandidates?: readonly ScopeBotInfo[];
  /** 群详情删除成功或远端检测到群已删除时触发。 */
  onDeleted?: () => void;
  onHistoryViewed?: (scopeId: string, lastMessageAt: string) => void;
  /** 受控群详情设置页开关（仅 room 生效；缺省走内部状态）。 */
  settingsOpen?: boolean;
  /** 群详情设置页开关变更回调。 */
  onSettingsOpenChange?: (open: boolean) => void;
}) {
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
  const isRoom = scope.scope.kind === 'room';
  const desktop = variant === 'desktop';
  /**
   * 群聊写端：resolver 路由（send 走成员所在可用 Host，members 只可达 authority）；
   * 未提供 resolver 时回退“读取 api 本身是权威节点完整 DesktopViewApi”的原路径。
   * 按 resolver + scopeId/revision + api + 在线态缓存；DM 永不解析（外层已强制只读）。
   */
  const sendApi = useMemo<DesktopViewApi | null>(() => {
    if (!isRoom) return null;
    if (resolveRoomApi) return resolveRoomApi(scope, 'send');
    return isScopeWritableApi(api) ? api : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveRoomApi, api, isRoom, scope.scope.scopeId, scope.scope.revision, online]);
  const membersApi = useMemo<DesktopViewApi | null>(() => {
    if (!isRoom || !scope.authorityDeviceId) return null;
    if (resolveRoomApi) return resolveRoomApi(scope, 'members');
    return scope.isAuthority && isScopeWritableApi(api) ? api : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveRoomApi, api, isRoom, scope.authorityDeviceId, scope.isAuthority, scope.scope.scopeId, scope.scope.revision, online]);
  const sendDeviceId = sendApi?.identity?.targetDeviceId;
  const sendDeviceName = sendDeviceId ? scopeDeviceName(sendDeviceId, bots, api) || '成员设备' : '成员设备';

  const [settingsOpenState, setSettingsOpenState] = useState(false);
  const isSettingsControlled = settingsOpen !== undefined;
  const showSettings = isRoom && (isSettingsControlled ? Boolean(settingsOpen) : settingsOpenState);

  const changeSettingsOpen = useCallback(
    (nextOpen: boolean) => {
      if (!isSettingsControlled) {
        setSettingsOpenState(nextOpen);
      }
      onSettingsOpenChange?.(nextOpen);
    },
    [isSettingsControlled, onSettingsOpenChange],
  );

  const [roomReply, setRoomReply] = useState<string | null>(null);
  const [history, setHistory] = useState<MessageHistoryPage['items']>([]);
  /** 向更早历史翻页的 descending 游标（MessageHistoryCursor 'history-before'）；null 表示没有更早页。 */
  const [histCursor, setHistCursor] = useState<MessageHistoryPage['nextCursor']>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState<string | null>(null);
  const histCursorRef = useRef<MessageHistoryPage['nextCursor']>(null);
  /** 增量轮询锚点：最新一页 tailCursor（最高 localId 的 ascending 'history' 游标）。 */
  const tailCursorRef = useRef<MessageCursor | null>(null);
  /** scopeHistory 请求序号：旧 reset/分页/轮询结果不得覆盖新请求或新视图。 */
  const histSeqRef = useRef(0);
  /** 同步在途标记：history 读取（reset/loadOlder/poll）合计最多一个在途；
   *  poll 与显式加载不会同时推进 seq 使对方丢 finally。 */
  const histBusyRef = useRef(false);
  const statePollBusyRef = useRef(false);
  /** 本页未命中的引用消息正文缓存：messageId → quote；undefined 表示尚未加载。 */
  const [replyQuotes, setReplyQuotes] = useState<Record<string, { author: string; text: string } | null>>({});
  /** 消息区滚动容器：prepend 旧页与吸底/新消息指示都挂这里。 */
  const msgListRef = useRef<HTMLDivElement | null>(null);
  /** 设置页打开前保存的消息滚动位置与底部标记：关闭设置页后原位恢复。 */
  const savedScrollTopRef = useRef<number | null>(null);
  const wasAtBottomRef = useRef(true);
  const prevShowSettingsRef = useRef(showSettings);
  /** 新消息计数：有新条目且视口不在底部时累加，点指示器回到底部清零。 */
  const [newCount, setNewCount] = useState(0);
  /** prepend 待应用的滚动补偿（渲染前记录 scrollHeight/Top，layout 后恢复）。 */
  const prependScrollRef = useRef<{ height: number; top: number } | null>(null);
  /** 初始倒序页到达后吸底一次（用户在历史中段不强制拽底）。 */
  const stickBottomRef = useRef(true);
  /** 文档可见性：页面隐藏时暂停轮询，恢复后下一轮 poll 沿 tailCursor 补齐。 */
  const [docVisible, setDocVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const onVisibility = (): void => setDocVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 远端同步或属性检测到当前群已被删除时，立即触发退出。
  useEffect(() => {
    if (isScopeDeleted(scope)) {
      onDeleted?.();
    }
  }, [scope, onDeleted]);

  /** 当前视口是否在底部（设置页隐藏消息容器时复用进入设置前的底部布尔）。 */
  function listAtBottom(): boolean {
    if (showSettings) return wasAtBottomRef.current;
    const el = msgListRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  /**
   * 全量重载：倒序取最新一页再反转为正序渲染，tailCursor 指向页内最高 localId。
   * reset 不保留旧条目（换 scope/显式刷新语义一致），由 useLayoutEffect 吸底。
   */
  const loadHistory = useCallback(async (reset: boolean) => {
    // 卸载后（包括迟到的 onAccepted）不再发新读取。
    if (!identity || !api.transportConnected || !mountedRef.current) return;
    const localSess = sess;
    const localScope = scope.scope.scopeId;
    const seq = ++histSeqRef.current;
    histBusyRef.current = true;
    if (reset) stickBottomRef.current = true;
    setHistLoading(true);
    try {
      const params: ScopeHistoryParams = { scopeId: localScope, limit: 30, order: 'descending' };
      const page = await api.call(identity, 'scopeHistory', params);
      if (seq !== histSeqRef.current || !mountedRef.current) return;
      if (sessionKey(api.identity) !== localSess) return;
      // items 倒序到达，渲染统一为正序；tailCursor 始终绑定最高 localId。
      const items = [...page.items].reverse();
      setHistory(items);
      histCursorRef.current = page.nextCursor;
      setHistCursor(page.nextCursor);
      tailCursorRef.current = pageTail(page);
      setHistError(null);
    } catch (e) {
      if (seq !== histSeqRef.current || !mountedRef.current) return;
      if (sessionKey(api.identity) === localSess) {
        setHistError('消息加载失败，请重试。');
        api.reportError(e);
      }
    } finally {
      // 只有自己仍是当前 seq 时才释放同步标记与 loading（否则已被新读取接管）。
      if (seq === histSeqRef.current) {
        histBusyRef.current = false;
        setHistLoading(false);
      }
    }
  }, [api, scope.scope.scopeId, identity, sess]);

  /** 向更早翻页：prepend 渲染前冻结滚动位置，layout 里恢复。 */
  const loadOlder = useCallback(async () => {
    if (!identity || !api.transportConnected || !mountedRef.current) return;
    const cursorAt = histCursorRef.current;
    if (!cursorAt) return;
    const localSess = sess;
    const localScope = scope.scope.scopeId;
    const seq = ++histSeqRef.current;
    histBusyRef.current = true;
    const el = msgListRef.current;
    if (el) prependScrollRef.current = { height: el.scrollHeight, top: el.scrollTop };
    setHistLoading(true);
    try {
      const page = await api.call(identity, 'scopeHistory', {
        scopeId: localScope,
        limit: 30,
        cursor: cursorAt,
        order: 'descending',
      });
      if (seq !== histSeqRef.current || !mountedRef.current) return;
      if (sessionKey(api.identity) !== localSess) return;
      const older = [...page.items].reverse();
      if (older.length === 0) prependScrollRef.current = null;
      setHistory((prev) => dedupeAppend(older, prev));
      // 空页不推进 histCursor：保持可重试同一 cursor，不把旧页游标清成 null 后无法再加载更早。
      if (older.length > 0) {
        histCursorRef.current = page.nextCursor;
        setHistCursor(page.nextCursor);
      }
      // tailCursor 只由最新页/增量轮询维护；旧页（历史更小的 localId）绝不回写，
      // 否则下次增量读取会从旧锚点回读整段历史。
      setHistError(null);
    } catch (e) {
      prependScrollRef.current = null;
      if (seq !== histSeqRef.current || !mountedRef.current) return;
      if (sessionKey(api.identity) === localSess) {
        setHistError('消息加载失败，请重试。');
        api.reportError(e);
      }
    } finally {
      if (seq === histSeqRef.current) {
        histBusyRef.current = false;
        setHistLoading(false);
      }
    }
  }, [api, scope.scope.scopeId, identity, sess]);

  /**
   * 增量轮询：tailCursor 之后 ascending 逐页 drain 到空；
   * seq 复用 histSeqRef —— 与 reset/loadOlder 同通道串行，跨 scope/节点切换立即过期。
   * histBusyRef 保证不与显式读取并发（并发时旧请求 seq 过期丢 finally 导致永久 loading）。
   * 空历史 tailCursor 为 null 时改为无游标 ascending 首页读取（含重试标记位：
   * 空页不推进 tail，但每轮 poll 都重试，新消息到达后第一次轮询即可发现）。
   */
  const pollNew = useCallback(async () => {
    if (!identity || !api.transportConnected) return;
    // 已有 history 读取在途（reset/loadOlder 或上一轮 poll）：本轮跳过，
    // 显式 loader 仍可抢占旧 poll（其 seq 过期自然作废旧请求）。
    if (histBusyRef.current) return;
    const tail = tailCursorRef.current;
    const localSess = sess;
    const localScope = scope.scope.scopeId;
    const seq = ++histSeqRef.current;
    histBusyRef.current = true;
    let cursor: MessageHistoryCursor | null = tail;
    let guard = 0;
    try {
      // tail 为 null（历史仍为空）：无游标 ascending 读一页即可覆盖“第一条新消息”。
      // 该页 tailCursor 为 null 时保持空态，下轮继续重试。
      while ((cursor || tail === null) && guard < 20) {
        guard += 1;
        const page: MessageHistoryPage = await api.call(identity, 'scopeHistory', {
          scopeId: localScope,
          limit: 30,
          cursor,
        });
        if (seq !== histSeqRef.current || !mountedRef.current) return;
        if (sessionKey(api.identity) !== localSess) return;
        // 每页立即显示 + 推进 tail：已取页不等后续页全部成功，中途失败/过期不丢已读消息。
        if (page.items.length > 0) {
          const wasAtBottom = listAtBottom();
          setHistory((prev) => dedupeAppend(prev, page.items));
          if (wasAtBottom) stickBottomRef.current = true;
          else setNewCount((n) => n + page.items.length);
        }
        const itemTail = pageTail(page);
        if (itemTail) tailCursorRef.current = itemTail;
        if (tail === null) break; // 空起始只读首页，不走链式翻页。
        cursor = page.nextCursor;
      }
    } catch (e) {
      // 轮询失败不打断列表：只上报，下一 tick 继续从同一 tailCursor 重试。
      if (seq === histSeqRef.current && mountedRef.current && sessionKey(api.identity) === localSess) {
        api.reportError(e);
      }
    } finally {
      if (seq === histSeqRef.current) histBusyRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, scope.scope.scopeId, identity, sess, showSettings]);

  /** 被动元数据检查：及时发现远端群解散（deletedAt）或群名/成员版本更新。 */
  const pollScopeState = useCallback(async () => {
    if (!isRoom || !mountedRef.current || statePollBusyRef.current) return;
    const sourceApi = membersApi && membersApi.identity && membersApi.transportConnected ? membersApi : api;
    const sourceId = sourceApi.identity;
    if (!sourceId || !sourceApi.transportConnected) return;
    const localSess = sessionKey(sourceId);
    const localScope = scope.scope.scopeId;
    statePollBusyRef.current = true;
    try {
      const latest = await sourceApi.call(sourceId, 'getScopeState', { scopeId: localScope });
      if (!mountedRef.current || sessionKey(sourceApi.identity) !== localSess) return;
      if (latest.scope.scopeId !== localScope) return;
      if (isScopeDeleted(latest)) {
        onDeleted?.();
        return;
      }
      if (
        latest.scope.revision !== scope.scope.revision ||
        latest.isAuthority !== scope.isAuthority ||
        latest.authorityDeviceId !== scope.authorityDeviceId
      ) {
        onChanged(latest);
      }
    } catch (e) {
      if (
        mountedRef.current &&
        sessionKey(sourceApi.identity) === localSess &&
        e &&
        typeof e === 'object' &&
        (e as { code?: unknown }).code === 'SCOPE_NOT_FOUND'
      ) {
        onDeleted?.();
      }
    } finally {
      statePollBusyRef.current = false;
    }
  }, [isRoom, membersApi, api, scope, onChanged, onDeleted]);

  // 渲染后应用滚动补偿：prepend 保持视口；吸底标记优先；设置页关闭后恢复进入设置前的滚动位置。
  useLayoutEffect(() => {
    const justClosedSettings = prevShowSettingsRef.current && !showSettings;
    prevShowSettingsRef.current = showSettings;
    if (showSettings) return;
    const el = msgListRef.current;
    if (!el) return;
    const pending = prependScrollRef.current;
    if (pending) {
      prependScrollRef.current = null;
      el.scrollTop = el.scrollHeight - pending.height + pending.top;
      savedScrollTopRef.current = el.scrollTop;
      return;
    }
    if (stickBottomRef.current) {
      stickBottomRef.current = false;
      el.scrollTop = el.scrollHeight;
      savedScrollTopRef.current = el.scrollTop;
      wasAtBottomRef.current = true;
      return;
    }
    if (justClosedSettings && savedScrollTopRef.current !== null) {
      el.scrollTop = savedScrollTopRef.current;
    }
  }, [history, showSettings]);

  const latestMessage = history.at(-1)?.message;
  useEffect(() => {
    if (
      isRoom && pageActive && docVisible && !showSettings &&
      newCount === 0 && wasAtBottomRef.current && latestMessage?.scopeId === scope.scope.scopeId
    ) {
      onHistoryViewed?.(latestMessage.scopeId, latestMessage.createdAt);
    }
  }, [isRoom, pageActive, docVisible, showSettings, newCount, latestMessage, scope.scope.scopeId, onHistoryViewed]);

  // 被回复消息不在本页时按 messageId 单独取回；缓存防重复请求与重复渲染抖动。
  useEffect(() => {
    if (!identity || !api.transportConnected) return;
    const inPage = new Set(history.map((m) => m.message.messageId));
    const missing = history
      .map((m) => m.message.replyTo)
      .filter((r): r is string => !!r && !inPage.has(r) && !(r in replyQuotes));
    if (missing.length === 0) return;
    const localSess = sess;
    const localScope = scope.scope.scopeId;
    let cancelled = false;
    void Promise.all(
      missing.map(async (id) => {
        try {
          const stored = await api.call(identity, 'getScopeMessage', { scopeId: localScope, messageId: id });
          return [id, stored ? { author: authorName(stored, bots), text: stored.message.text } : null] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled || !mountedRef.current || sessionKey(api.identity) !== localSess) return;
      setReplyQuotes((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => { cancelled = true; };
  }, [history, replyQuotes, api, identity, sess, scope.scope.scopeId, bots]);

  function onMsgListScroll() {
    if (showSettings) return;
    const el = msgListRef.current;
    if (!el) return;
    savedScrollTopRef.current = el.scrollTop;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    wasAtBottomRef.current = atBottom;
    if (atBottom) setNewCount(0);
  }

  function jumpToLatest() {
    const el = msgListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      savedScrollTopRef.current = el.scrollTop;
    }
    wasAtBottomRef.current = true;
    setNewCount(0);
  }

  function openSettings() {
    if (!isRoom) return;
    const el = msgListRef.current;
    if (el && !showSettings) {
      savedScrollTopRef.current = el.scrollTop;
      wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    }
    changeSettingsOpen(true);
  }

  // 真正换 scope：重置内部设置视图并使旧历史/轮询请求全部过期。
  useEffect(() => {
    histSeqRef.current += 1;
    histBusyRef.current = false;
    statePollBusyRef.current = false;
    histCursorRef.current = null;
    tailCursorRef.current = null;
    prependScrollRef.current = null;
    savedScrollTopRef.current = null;
    wasAtBottomRef.current = true;
    stickBottomRef.current = true;
    setHistory([]);
    setHistCursor(null);
    setHistError(null);
    setHistLoading(false);
    setNewCount(0);
    setReplyQuotes({});
    setSettingsOpenState(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.scope.scopeId]);

  // 同一会话重连时从已读位置增量接续，保留已翻看的旧页和当前视口。
  useEffect(() => {
    if (!identity || !online) return;
    if (tailCursorRef.current) void pollNew();
    else void loadHistory(true);
  }, [loadHistory, pollNew, identity, online]);

  // 可见 + 在线 + 文档可见时每 2s 沿 tailCursor 增量轮询并核对群状态；隐藏/离线停表。
  useEffect(() => {
    if (!identity || !online || !pageActive || !docVisible) return;
    const timer = window.setInterval(() => {
      void pollNew();
      void pollScopeState();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pollNew, pollScopeState, identity, online, pageActive, docVisible]);

  const memberCount = scope.scope.members.length;
  const title = desktop && !isRoom && participant ? dmRowTitle(scope, bots, participant) : conversationTitle(scope.scope, bots);
  return (
    <div className="scope-detail">
      <div
        className={showSettings ? 'scope-chat-surface scope-chat-surface-hidden' : 'scope-chat-surface'}
        aria-hidden={showSettings || undefined}
      >
        <ConversationChatHeader
          title={title}
          subtitle={isRoom ? `${memberCount} 位成员` : undefined}
          avatar={<ConversationGroupAvatar members={scope.scope.members} bots={bots} size={30} />}
          onBack={onBack}
          readOnly={!canWrite}
          onOpenMenu={isRoom && !desktop ? openSettings : undefined}
          onShowMembers={isRoom && desktop ? openSettings : undefined}
          membersLabel={isRoom && desktop ? '成员' : undefined}
        />

        {/* room/DM 均可被动查看 scopeHistory 与分页；仅 room + 可写 API 允许用户消息输入。 */}
        <div className="message-list scope-message-list" ref={msgListRef} onScroll={onMsgListScroll}>
          {!online ? <div className="status">离线：显示最后读取的消息，不自动请求。</div> : null}
          {histError ? (
            <div className="error-banner" role="alert">
              {histError}
              <button type="button" onClick={() => void loadHistory(true)} disabled={!online}>重试</button>
            </div>
          ) : null}
          {histCursor && !histLoading ? (
            <button type="button" className="load-more scope-load-earlier" onClick={() => void loadOlder()} disabled={!online}>加载更早消息</button>
          ) : null}
          {history.length === 0 && !histLoading && !histError ? <div className="empty-state">暂无消息。</div> : null}
          {history.map((msg, i) => {
            const replyTo = msg.message.replyTo;
            const replySource = replyTo ? history.find((m) => m.message.messageId === replyTo) : undefined;
            const replyQuote = replyTo
              ? replySource
                ? { author: authorName(replySource, bots), text: replySource.message.text }
                : replyQuotes[replyTo] ?? null
              : null;
            const divider = i === 0
              ? <ConversationTimeDivider at={msg.message.createdAt} />
              : <ConversationTimeDivider at={msg.message.createdAt} previousAt={history[i - 1].message.createdAt} />;
            return (
              <div key={msg.message.messageId} className="scope-message-wrap">
                {divider}
                <ConversationMessage
                  message={msg}
                  authorName={authorName(msg, bots)}
                  replyQuote={replyQuote}
                  onReply={canWrite && isRoom ? () => setRoomReply(msg.message.messageId) : undefined}
                  onOpenLink={onOpenLink}
                />
              </div>
            );
          })}
          {histLoading ? <div className="status">加载中…</div> : null}
          {newCount > 0 ? (
            <button type="button" className="scope-new-banner" onClick={jumpToLatest}>
              查看 {newCount} 条新消息
            </button>
          ) : null}
        </div>

        {canWrite && isRoom ? (
          sendApi ? (
            <RoomComposer
              api={sendApi}
              scopeId={scope.scope.scopeId}
              replyTo={roomReply}
              onReplyTo={setRoomReply}
              onAccepted={() => void (desktop ? pollNew() : loadHistory(true))}
              deviceName={desktop ? sendDeviceName : undefined}
              onOpenSendRecords={desktop ? onOpenSendRecords : undefined}
            />
          ) : (
            /* 有 resolver 但写端未就绪：待连接禁用区，不标“只读”。 */
            <div className="composer scope-composer">
              <div className="status">{desktop
                ? '暂时连不上群聊的成员设备。草稿保存在本机。'
                : '写通道待连接，暂不能发送；连接后可正常输入。'}</div>
              <div className="scope-composer-row">
                <textarea
                  className="composer-input scope-composer-input"
                  rows={2}
                  disabled
                  placeholder="给群聊发消息…（Enter 发送，Shift+Enter 换行）"
                />
                <button type="button" className="primary-button scope-send-btn" disabled title="发送（Enter）">
                  <SendHorizontal size={15} />
                  发送
                </button>
              </div>
            </div>
          )
        ) : !desktop ? (
          <p className="hint scope-readonly-hint">仅供查看</p>
        ) : null}
      </div>

      {showSettings ? (
        <GroupSettings
          api={api}
          variant={variant}
          membersApi={membersApi}
          scope={scope}
          bots={bots}
          memberCandidates={memberCandidates ?? bots}
          canWrite={canWrite}
          onChanged={onChanged}
          onClose={() => changeSettingsOpen(false)}
          onDeleted={onDeleted}
        />
      ) : null}
    </div>
  );
}

function ScopeCreateForm({ api, bots, onCreated }: {
  api: DesktopViewApi;
  bots: readonly ConversationBot[];
  onCreated: (s: ScopeInfo) => void;
}) {
  const identity = api.identity;
  const [kind, setKind] = useState<'room' | 'dm'>('room');
  const [members, setMembers] = useState<MessageMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function submit() {
    if (!identity || busy) return;
    // room 最少 2 个成员（后端已拒绝单成员房间）；DM 固定 2 个。
    if (kind === 'room' && members.length < 2) {
      setError('群聊至少需要 2 个成员 Bot');
      return;
    }
    if (kind === 'dm' && members.length !== 2) {
      setError('智能体私聊固定两个 Bot');
      return;
    }
    setBusy(true);
    setError(null);
    const requestId = crypto.randomUUID();
    try {
      const scope = await api.mutateIntent(identity, 'createScope', {
        input: { requestId, kind, members },
      });
      if (!mountedRef.current) return;
      setKind('room');
      setMembers([]);
      onCreated(scope);
    } catch (e) {
      if (!mountedRef.current) return;
      setError('创建会话失败，请重试；未确认完成不会自动重发。');
      api.reportError(e);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <form className="form-grid scope-create-form" onSubmit={(ev) => { ev.preventDefault(); void submit(); }}>
      <div className="field">
        <label>类型</label>
        <div className="kind-row pill-tabs scope-kind-tabs" role="radiogroup" aria-label="会话类型">
          <button type="button" className={kind === 'room' ? 'active' : ''} onClick={() => setKind('room')} disabled={busy}>
            <Users size={13} /> 群聊房间
          </button>
          <button type="button" className={kind === 'dm' ? 'active' : ''} onClick={() => setKind('dm')} disabled={busy}>
            <MessageSquare size={13} /> 智能体私聊
          </button>
        </div>
      </div>
      <MemberEditor current={members} candidates={bots} names={bots} onChange={setMembers} />
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      <div className="form-actions">
        <button type="submit" className="primary-button" disabled={busy || !identity || !api.transportConnected}>
          {busy ? '创建中…' : '创建会话'}
        </button>
      </div>
    </form>
  );
}

/** DM 行标题：另一成员名字（participant 是自身则取对方）；多会话靠预览/时间区分，不追加 scope ID。 */
function dmRowTitle(scope: ScopeInfo, bots: readonly ConversationBot[], self?: MessageMember): string {
  const peers = self
    ? scope.scope.members.filter((m) => !(m.deviceId === self.deviceId && m.botId === self.botId))
    : scope.scope.members;
  const target = peers.length > 0 ? peers : scope.scope.members;
  return target.map((m) => conversationMemberName(m, bots)).join('、');
}

export function Scopes({
  api,
  pageActive = true,
  variant = 'mobile',
  onOpenSendRecords,
  initialBotId,
  initialScopeId,
  readOnly = false,
  onStopBot,
  onOpenBot,
  scopeKind,
  participant,
  participantName,
  selectedScopeId,
  onSelectScope,
  onBack,
  detailOnly = false,
  knownBots,
  onOpenLink,
  resolveRoomApi,
  memberCandidates,
  onDeleted,
  onHistoryViewed,
  settingsOpen,
  onSettingsOpenChange,
}: {
  /** 完整视图 API（远端桌面/移动远端）或本机只读窄 API（mobile lane 适配器）。 */
  api: DesktopViewApi | ScopeReadApi;
  pageActive?: boolean;
  variant?: 'desktop' | 'mobile';
  onOpenSendRecords?: (target: RoomSendRecordsTarget) => void;
  /** 进入时预选 scope。 */
  initialScopeId?: string;
  /** 兼容保留：宿主旧导航传入；新消息界面不再按 Bot 筛选消息。 */
  initialBotId?: string;
  /** 强制只读浏览：即便 api 是完整实现也不显示编辑/发送/成员变更控件。 */
  readOnly?: boolean;
  /** 兼容保留：成员观察面板已移除，此回调不再触发。 */
  onStopBot?: (botId: string) => Promise<void>;
  /** 兼容保留：成员观察面板已移除，此回调不再触发。 */
  onOpenBot?: (botId: string, deviceId: string) => void;
  /** 只列出指定类型的 scope；participant 另行强制 dm。 */
  scopeKind?: 'room' | 'dm';
  /** DM 私聊列表参与者：列表仅含同 deviceId+botId 成员的 dm scope，不自动进入第一条。 */
  participant?: MessageMember;
  /** participant 列表标题（“A 的私聊”的 A）；缺省用目录名。 */
  participantName?: string;
  /** 受控选中：明确 null 只显示列表；不传则走内部选中状态（兼容旧行为）。 */
  selectedScopeId?: string | null;
  /** 受控选择回调：行点击与返回都经它通知父级（系统返回逐级清空 selectedScopeId）。 */
  onSelectScope?: (scopeId: string | null) => void;
  /** detailOnly 详情页与 DM 列表页的返回入口（回到来源列表/Hub）。 */
  onBack?: () => void;
  /** 只渲染详情区（群聊从主列表直达内容）：不显示另一份群聊/私聊列表。 */
  detailOnly?: boolean;
  /** 宿主已知 Bot 目录（含归档/远端）：与 api.listBots 按 deviceId+botId 合并后统一命名。 */
  knownBots?: readonly ScopeBotInfo[];
  /** Markdown 链接打开方式（桌面 Tauri 无 mobile 桥时传入）。 */
  onOpenLink?: (href: string) => void | Promise<unknown>;
  /** 群聊写端解析器：传入即表示群聊提供可写入口（写端未就绪时详情降级为待连接，不标只读）。 */
  resolveRoomApi?: RoomApiResolver;
  /** 新增成员候选（未归档 Bot）；缺省用合并目录；现有成员名字始终走 knownBots。 */
  memberCandidates?: readonly ScopeBotInfo[];
  /** 群详情删除成功或远端检测到群已删除时触发：父级回到 Hub / 清 stage 并刷新群列表、移除置顶。 */
  onDeleted?: () => void;
  /** 用户在可见群聊中查看到最新消息时通知会话列表。 */
  onHistoryViewed?: (scopeId: string, lastMessageAt: string) => void;
  /** 受控群详情设置页开关（仅 room 生效；缺省走内部状态）。 */
  settingsOpen?: boolean;
  /** 群详情设置页开关变更回调（三点进入 true，设置页返回 false）。 */
  onSettingsOpenChange?: (open: boolean) => void;
}) {
  void initialBotId;
  void onStopBot;
  void onOpenBot;
  /** 写控件统一门槛：真实写方法全部存在 + 未声明只读。 */
  const canWrite = !readOnly && isScopeWritableApi(api);
  const identity = api.identity;
  const sess = sessionKey(identity);
  const online = api.transportConnected;
  const targetKey = identity ? `${identity.profileId}|${identity.kind}|${identity.targetDeviceId}` : null;
  const [selectedIdState, setSelectedIdState] = useState<string | null>(initialScopeId ?? null);
  /** 受控时以 selectedScopeId 为准（明确 null 只显示列表）；否则内部状态，兼容旧调用方。 */
  const isControlled = selectedScopeId !== undefined;
  const selectedId = isControlled ? selectedScopeId : selectedIdState;
  const setSelectedId = (id: string | null) => {
    onSelectScope?.(id);
    if (!isControlled) setSelectedIdState(id);
  };
  const [selected, setSelected] = useState<ScopeInfo | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [bots, setBots] = useState<BotRecord[]>([]);
  /** 目录 + 实时 listBots 合并后的命名/头像表（已知优先 listBots，目录提供归档/远端名与设备名）。 */
  const mergedBots = useMemo(() => mergeKnownBots(bots, knownBots), [bots, knownBots]);
  const dmLabel = variant === 'desktop' ? '智能体间通信' : '私聊';
  const listTitle = participant
    ? (participantName ?? conversationMemberName(participant, mergedBots)) + `的${dmLabel}`
    : scopeKind === 'dm'
      ? dmLabel
      : scopeKind === 'room'
        ? '群聊'
        : '群聊 / 智能体私聊';
  /** participant/scopeKind=dm 路径为只读 DM 浏览：隐藏创建等写入口。 */
  const showCreateEntry = canWrite && !participant && scopeKind !== 'dm' && !detailOnly;
  /**
   * 会话行列表（两种类型同用 ConversationRow + 真实预览/时间）：
   * DM participant/scopeKind 过滤由 useScopeConversations + 下方 rowConversations 负责；
   * useScopeConversations 的 kind 只在纯 DM 列表时下发，混合列表取全类型自行过滤。
   */
  const rowListMode = !detailOnly;
  const convSources = useMemo<ScopeConversationSource[]>(
    () => (identity && rowListMode ? [{ api, identity, bots: mergedBots, label: targetKey ?? undefined }] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, sess, identity, mergedBots, rowListMode, targetKey],
  );
  const convList = useScopeConversations(
    convSources,
    pageActive,
    participant || scopeKind === 'dm' ? 'dm' : undefined,
  );
  /** participant 过滤在 kind=dm 之上再要求 deviceId+botId 成员匹配；同时过滤已删除墓碑。 */
  const rowConversations = useMemo(
    () => convList.items.filter((c) => {
      if (isScopeDeleted(c.scope)) return false;
      if (scopeKind && c.scope.scope.kind !== scopeKind) return false;
      if (participant) {
        return c.scope.scope.kind === 'dm'
          && c.scope.scope.members.some((m) => m.deviceId === participant.deviceId && m.botId === participant.botId);
      }
      return true;
    }),
    [convList.items, scopeKind, participant],
  );
  const scopesSeqRef = useRef(0);
  const botsSessRef = useRef('');
  const targetKeyRef = useRef<string | null>(null);
  const refreshConversations = convList.refresh;
  const markConversationDeleted = convList.markDeleted;

  const handleScopeDeleted = useCallback(() => {
    onSettingsOpenChange?.(false);
    if (selectedId) markConversationDeleted(selectedId);
    setSelected(null);
    setDetailError(null);
    if (!detailOnly) {
      onSelectScope?.(null);
      if (!isControlled) setSelectedIdState(null);
      refreshConversations();
    }
    if (onDeleted) {
      onDeleted();
    } else if (detailOnly) {
      onBack?.();
    }
  }, [detailOnly, isControlled, selectedId, onSelectScope, onDeleted, onBack, onSettingsOpenChange, refreshConversations, markConversationDeleted]);

  useEffect(() => () => { scopesSeqRef.current += 1; }, []);

  useEffect(() => {
    // 断开（generation 变化）保留同 profile+target 已加载列表/选择，供离线草稿与入队；
    // 真正换 profile/target 才清旧显示。
    // 换目标/断开时清选择；列表项由 useScopeConversations 的账户快照机制管理。
    if (targetKey === null) {
      targetKeyRef.current = null;
      setSelectedId(null);
      setSelected(null);
      return;
    }
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
      setSelectedId(null);
      setSelected(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  // 初次加载后应用 initialScopeId 导航（仅一次；换目标后重新生效）。
  // 选中交给选中 effect 直接 getScopeState 并核对 kind/participant，
  // 不依赖列表第一页出现（scope 多于首页时不至永远空白）。
  const initialNavDoneRef = useRef(false);
  useEffect(() => {
    if (initialNavDoneRef.current || !initialScopeId) return;
    initialNavDoneRef.current = true;
    setSelectedId(initialScopeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialScopeId]);

  // 换目标（profile/target）时重新允许初始导航。
  useEffect(() => {
    initialNavDoneRef.current = false;
  }, [targetKey]);

  useEffect(() => {
    if (!identity || !selectedId) {
      setSelected(null);
      setDetailError(null);
      return;
    }
    // 离线不自动 call：保留同目标最后读取的详情。
    if (!api.transportConnected) return;
    const localSess = sess;
    let cancelled = false;
    void api.call(identity, 'getScopeState', { scopeId: selectedId }).then((s) => {
      if (!cancelled && sessionKey(api.identity) === localSess) {
        if (isScopeDeleted(s)) {
          handleScopeDeleted();
          return;
        }
        // 详情核对：scopeKind/participant 不匹配的内容绝不渲染。
        if (scopeKind && s.scope.kind !== scopeKind) {
          setSelected(null);
          setDetailError('该会话不是预期的类型，已停止显示。');
          return;
        }
        if (participant && !(s.scope.kind === 'dm' && s.scope.members.some((m) => m.deviceId === participant.deviceId && m.botId === participant.botId))) {
          setSelected(null);
          setDetailError('该会话不属于此 Bot 的私聊，已停止显示。');
          return;
        }
        setSelected(s);
        setDetailError(null);
      }
    }).catch((e) => {
      if (!cancelled && sessionKey(api.identity) === localSess) {
        if (e && typeof e === 'object' && (e as { code?: unknown }).code === 'SCOPE_NOT_FOUND') {
          handleScopeDeleted();
          return;
        }
        setDetailError('会话加载失败，请重试。');
        api.reportError(e);
      }
    });
    return () => { cancelled = true; };
  }, [api, sess, identity, selectedId, online, scopeKind, participant, handleScopeDeleted]);

  useEffect(() => {
    if (!identity || botsSessRef.current === sess || !api.transportConnected) return;
    const localSess = sess;
    let cancelled = false;
    void api.call(identity, 'listBots', {}).then((bs) => {
      if (!cancelled && sessionKey(api.identity) === localSess) {
        setBots(bs);
        botsSessRef.current = localSess;
      }
    }).catch((e) => {
      if (!cancelled && sessionKey(api.identity) === localSess) api.reportError(e);
    });
    return () => { cancelled = true; };
  }, [api, sess, identity, online]);

  function selectScope(id: string) {
    onSettingsOpenChange?.(false);
    setSelectedId(id);
  }

  /** 详情写权限：仅群聊且未声明只读；有 resolver 即视为可写入口，无 resolver 回退完整 api 原路径；DM 强制只读。 */
  const detailCanWrite = Boolean(
    !readOnly
    && !participant
    && scopeKind !== 'dm'
    && selected?.scope.kind === 'room'
    && (resolveRoomApi != null || isScopeWritableApi(api)),
  );
  /** 详情返回：detailOnly 回宿主；受控 DM 内容页回 DM 列表；内部选择回列表。 */
  const detailBack = detailOnly ? onBack : () => {
    onSettingsOpenChange?.(false);
    setSelectedId(null);
  };

  return (
    <div
      className={
        'conversation-layout scope-shell'
        + (variant === 'desktop' ? ' scope-shell-desktop' : '')
        + (variant === 'desktop' && (participant || scopeKind === 'dm') ? ' scope-shell-desktop-dm' : '')
        + (selectedId ? ' scope-shell-detail-open' : '')
        + (detailOnly ? ' scope-shell-detail-only' : '')
      }
    >
      <aside className="entity-list scope-list">
        <ConversationChatHeader
          title={listTitle}
          avatar={
            participant
              ? memberAvatar(participant, mergedBots, 30)
              : scopeKind === 'dm'
                ? <MessageSquare size={18} />
                : <Users size={18} />
          }
          onBack={!detailOnly ? onBack : undefined}
        />
        <div className="scope-list-toolbar">
          <button
            type="button"
            className="icon-button"
            onClick={() => convList.refresh()}
            disabled={!online || convList.loading}
            title="刷新列表"
            aria-label="刷新列表"
          >
            <RefreshCw size={14} className={convList.loading ? 'scope-spin' : undefined} />
          </button>
          {showCreateEntry ? (
            <button className="toolbar-btn" onClick={() => setShowCreate((v) => !v)} disabled={!identity}>
              <Plus size={13} />
              {showCreate ? '取消' : '新建会话'}
            </button>
          ) : null}
        </div>
        {convList.error ? (
          <div className="error-banner" role="alert">
            会话列表加载失败，请重试。
            <button type="button" onClick={() => convList.refresh()}>重试</button>
          </div>
        ) : null}
        {!online ? <div className="status">离线：显示最后读取的会话列表，不自动请求。</div> : null}
        {showCreate && showCreateEntry && identity && isScopeWritableApi(api) ? (
          <ScopeCreateForm
            api={api}
            bots={mergedBots}
            onCreated={(s) => {
              setShowCreate(false);
              selectScope(s.scope.scopeId);
            }}
          />
        ) : null}
        {rowConversations.length === 0 && !convList.loading && !convList.error ? (
          <div className="empty-state">{participant ? (variant === 'desktop' ? '暂无智能体间通信。' : '该 Bot 暂无私聊。') : '暂无会话。'}{!participant && identity ? '点击“新建会话”创建。' : (!identity ? '请先连接。' : '')}</div>
        ) : (
          <ul className="entity-list-items">
            {rowConversations.map((c) => (
              <li key={c.key}>
                <ConversationRow
                  title={
                    participant
                      ? dmRowTitle(c.scope, mergedBots, participant)
                      : conversationTitle(c.scope.scope, mergedBots)
                  }
                  preview={c.lastPreview}
                  timestamp={c.lastActivityAt}
                  avatar={
                    <ConversationGroupAvatar
                      members={c.scope.scope.members}
                      bots={mergedBots}
                      size={34}
                    />
                  }
                  selected={selectedId === c.scope.scope.scopeId}
                  onOpen={() => selectScope(c.scope.scope.scopeId)}
                />
              </li>
            ))}
          </ul>
        )}
        {convList.loading ? <div className="status">加载中…</div> : null}
      </aside>
      <section className="chat-pane">
        {identity && selected && selected.scope.scopeId === selectedId && !isScopeDeleted(selected)
          && (!scopeKind || selected.scope.kind === scopeKind)
          && (!participant || (selected.scope.kind === 'dm' && selected.scope.members.some((m) => m.deviceId === participant.deviceId && m.botId === participant.botId))) ? (
          <ScopeDetail
            key={`${selected.scope.scopeId}_${targetKey}`}
            api={api}
            variant={variant}
            onOpenSendRecords={onOpenSendRecords}
            participant={participant}
            scope={selected}
            bots={mergedBots}
            onChanged={(s) => {
              if (isScopeDeleted(s)) {
                handleScopeDeleted();
                return;
              }
              setSelected(s);
            }}
            pageActive={pageActive}
            // DM 路径（participant/scopeKind=dm/所选 scope 为 dm）强制只读：写控件隐藏。
            canWrite={detailCanWrite}
            onBack={detailBack}
            onOpenLink={onOpenLink}
            resolveRoomApi={resolveRoomApi}
            memberCandidates={memberCandidates}
            onDeleted={handleScopeDeleted}
            onHistoryViewed={onHistoryViewed}
            settingsOpen={settingsOpen}
            onSettingsOpenChange={onSettingsOpenChange}
          />
        ) : detailError ? (
          <div className="error-banner" role="alert">{detailError}</div>
        ) : detailOnly && selectedId ? (
          <div className="status">加载中…</div>
        ) : (
          <div className="empty-state">{variant === 'desktop' && (participant || scopeKind === 'dm')
            ? '选择一条通信查看详情。'
            : '在左侧选择一个群聊或私聊查看详情。'}</div>
        )}
      </section>
    </div>
  );
}
