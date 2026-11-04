import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DesktopDraftEntry,
  DesktopDraftFileRef,
  DesktopIdentity,
  DesktopViewApi,
} from './types';
import type { ImageAttachment } from '../../../host-core/index.js';
import type {
  PendingCursor,
  PendingEnqueueInput,
  PendingListPage,
  PendingRecord,
} from '../../../host-core/index.js';

export interface DraftSnapshot {
  text: string;
  files: DesktopDraftFileRef[];
  attachments?: ImageAttachment[];
}

export type DraftAttemptPhase =
  | 'locked'
  | 'enqueued'
  | 'cleared'
  | 'not-sent'
  | 'failed'
  | 'unconfirmed';

/** 一次发送 attempt：冻结完整 input/owner、已知 pending.id、阶段与错误（跨挂载保留）。 */
export interface DraftAttempt {
  /** attemptId（本会话本地锁标识，非业务 ID）。 */
  id: string;
  /** 冻结身份副本：对账/队列查询使用，避免断开或切换后丢失原请求定位。 */
  owner: DesktopIdentity;
  kind: 'primary' | 'room';
  phase: DraftAttemptPhase;
  /** 冻结完整 PendingEnqueueInput：target/bot 或 scope/replyTo/实际发送文本。 */
  input: PendingEnqueueInput;
  pendingId: string | null;
  error: string | null;
  /** 只在本地空草稿保存成功时置 true，后续错误不得抹去；只读对账据此结束 attempt。 */
  cleared: boolean;
  /** 发送前 client 已知的持久草稿基线：clearDraft 的 expected 之一，避免误清别人更新的草稿。 */
  baseDraft: DesktopDraftEntry;
  /** 发送时冻结的当前编辑（files 已复制）：clearDraft 的 expected 之一。 */
  draft: DesktopDraftEntry;
}

/** 固定 handle：后续所有操作按 handle 定位并核对 attemptId。 */
export interface DraftHandle {
  key: string;
  attemptId: string;
}

export type ReconcileAction = 'finished' | 'kept' | 'ready-clear-retry' | 'unconfirmed';

export interface ReconcileOutcome {
  action: ReconcileAction;
  found: boolean;
  recordId: string | null;
  recordState: string | null;
  /** 非空表示查询未完成/需回到原连接/未遍历完等，可直接展示。 */
  note: string | null;
}

export interface DraftWidgetState {
  key: string | null;
  text: string;
  files: DesktopDraftFileRef[];
  attachments: ImageAttachment[];
  dirty: boolean;
  busy: boolean;
  error: string | null;
  /** 自动保存因草稿冲突已暂停（含卸载 force）：只由显式保存/采用新版解除。 */
  savePaused: boolean;
  /** 冲突后读到的新版持久草稿（供查看/采用）；无则 null。 */
  conflict: DraftSnapshot | null;
  attempt: DraftAttempt | null;
  editText(v: string): void;
  addFile(ref: DesktopDraftFileRef): void;
  removeFile(index: number): void;
  /** 仅已成功上传到目标 Host 的附件才允许进入草稿（按 id 元数据排序保留）。
   *  expectedKey 提供原子归属校验：当前 keyRef 不匹配/同 id 已存在/超限（4 张）均拒绝并返回 false。 */
  addAttachment(att: ImageAttachment, expectedKey?: string): boolean;
  removeAttachment(index: number): void;
  retrySave(): void;
  /** 同步取得唯一发送锁并冻结完整输入（首 await 前调用），返回实际冻结副本。 */
  beginSend(input: PendingEnqueueInput): { key: string; handle: DraftHandle; attempt: DraftAttempt } | null;
  /** join 在途保存（attempt 已锁定，队列 autosave 检查冻结代次后跳过）。 */
  waitQuiet(handle: DraftHandle): Promise<void>;
  /** enqueue 成功后记录已知 pending.id，phase -> enqueued。 */
  setPending(handle: DraftHandle, pendingId: string): void;
  /** 用 shared.clearDraft(key,[baseDraft,draft]) 取得持久化 CAS：成功才清内存/标 clean 并 phase -> cleared。 */
  confirmCleared(handle: DraftHandle): Promise<'cleared' | 'conflict' | 'failed'>;
  /** 确定回执后结束 attempt（清锁）。 */
  finishSend(handle: DraftHandle): void;
  /** enqueue 未产生记录（not-sent）：保留原编辑，可显式释放。 */
  markNotSent(handle: DraftHandle, error: string): void;
  /** 失败（已入队但本地清空失败或结果异常）：保留冻结内容与原 ID。 */
  markFailed(handle: DraftHandle, error: string): void;
  /** 未确认：保留原记录信息，phase -> unconfirmed（忙碌结束）。 */
  markUnconfirmed(handle: DraftHandle): void;
  /**
   * 只读对账：有 pending.id 用 pending_get（必要时显式 pending_reconcile）；
   * 无 id 用 pending_list 分页按冻结 kind/target/bot 或 scope/业务 ID 匹配。
   * 查询到确定受理/终态且草稿已清空才结束本地 attempt；其余保持锁。
   */
  reconcile(handle: DraftHandle): Promise<ReconcileOutcome>;
  /** 仅限 not-sent（确定未入队）释放编辑；其余拒绝并返回错误。 */
  releaseIfNotSent(handle: DraftHandle): { ok: boolean; error?: string };
  /** 清稿失败且已核实原记录后，显式重试本地清空（同样走 clearDraft CAS，不触发远程 send）。 */
  retryClearAfterVerify(handle: DraftHandle): Promise<'cleared' | 'conflict' | 'failed'>;
  /** 冲突且原记录已读核实：采用读到的新版草稿为本地编辑并结束旧 attempt，不清磁盘、不发送。 */
  adoptNewerDraftAndFinish(handle: DraftHandle): { ok: boolean; error?: string };
  /** 结束确定未派发的尝试后，仅从当前持久快照更新内存，不写磁盘。 */
  adoptPersistedDraft(key: string): Promise<{ ok: boolean; error?: string }>;
}

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const r = e as Record<string, unknown>;
    const code = typeof r.code === 'string' ? r.code : '';
    const message = typeof r.message === 'string' ? r.message : '';
    if (code) return message ? `${code}: ${message}` : code;
    if (message) return message;
  }
  return String(e);
}

interface MemoryDraft {
  text: string;
  files: DesktopDraftFileRef[];
  attachments: ImageAttachment[];
  dirty: boolean;
  version: number;
  savedVersion: number;
  lastError: string | null;
  timer: number | null;
  chain: Promise<void> | null;
  attempt: DraftAttempt | null;
  /** 普通保存遇 CAS 冲突：暂停自动写（含卸载 force），直到显式保存或采用新版。 */
  savePaused: boolean;
  /** 冲突后读到的新版持久草稿。 */
  conflict: DraftSnapshot | null;
}

const memory = new Map<string, MemoryDraft>();
const listeners = new Map<string, Set<() => void>>();

function getMem(key: string): MemoryDraft {
  let m = memory.get(key);
  if (!m) {
    m = {
      text: '',
      files: [],
      attachments: [],
      dirty: false,
      version: 0,
      savedVersion: 0,
      lastError: null,
      timer: null,
      chain: null,
      attempt: null,
      savePaused: false,
      conflict: null,
    };
    memory.set(key, m);
  }
  return m;
}

function subscribe(key: string, fn: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => {
    const s = listeners.get(key);
    if (s) {
      s.delete(fn);
      if (s.size === 0) listeners.delete(key);
    }
  };
}

function notify(key: string) {
  const set = listeners.get(key);
  if (set) {
    for (const fn of [...set]) fn();
  }
}

function isMidFlight(m: MemoryDraft): boolean {
  return !!m.attempt && (m.attempt.phase === 'locked' || m.attempt.phase === 'enqueued' || m.attempt.phase === 'cleared');
}

/** 拷贝草稿（files/attachments 逐项复制，保持原字段与顺序）。 */
function copyDraft(entry: DesktopDraftEntry): DesktopDraftEntry {
  return {
    text: entry.text,
    files: entry.files.map((f) => ({ ...f })),
    ...(entry.attachments?.length ? { attachments: entry.attachments.map((a) => ({ ...a })) } : {}),
  };
}

/** client 已知的持久草稿副本（冲突后用于查看/采用；core 写失败会 ui_get 回读刷新）。 */
function latestPersistedDraft(api: DesktopViewApi, key: string): DraftSnapshot | null {
  const saved = api.snapshot?.state.drafts[key];
  return saved
    ? {
        text: saved.text,
        files: saved.files.map((f) => ({ ...f })),
        ...(saved.attachments?.length ? { attachments: saved.attachments.map((a) => ({ ...a })) } : {}),
      }
    : null;
}

/** core 的已知版本冲突：clearDraft 直接抛 DRAFT_CONFLICT，saveDraft→ui_set CAS 抛 REQUEST_CONFLICT。 */
function isDraftConflict(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  return code === 'DRAFT_CONFLICT' || code === 'REQUEST_CONFLICT';
}

interface AttemptRef {
  mem: MemoryDraft;
  attempt: DraftAttempt;
}

/** 核对 handle 仍指向同一 attempt 并拿到收窄后的 attempt；异步结果应用前必须重查。 */
function currentAttempt(handle: DraftHandle): AttemptRef | null {
  const mem = getMem(handle.key);
  const attempt = mem.attempt;
  if (!attempt || attempt.id !== handle.attemptId) return null;
  return { mem, attempt };
}

/** 按冻结输入匹配待发送记录（kind/target/bot 或 scope/业务 ID，并核对文本与 room replyTo）。 */
function matchesInput(item: PendingRecord, input: PendingEnqueueInput): boolean {
  if (item.targetDeviceId !== input.targetDeviceId) return false;
  if (item.text !== input.text) return false;
  if (input.kind === 'primary') {
    return item.kind === 'primary' && item.botId === input.botId && item.requestId === input.requestId;
  }
  return (
    item.kind === 'room' &&
    item.scopeId === input.scopeId &&
    item.messageId === input.messageId &&
    item.replyTo === (input.replyTo ?? null)
  );
}

/** 本轮只读对账确认到的原记录（attemptId → record）：只有登记过的才允许重试本地清空。 */
const verifiedRecords = new Map<string, { recordId: string; definite: boolean }>();

function recordStateOf(item: PendingRecord): string {
  return item.state;
}

/**
 * 共享草稿 + 发送 attempt 管理（conversations 组件使用）。
 * - 模块内存按 draftKey 保留编辑与 attempt，切换视图/Bot 回来仍恢复原 ID 与锁。
 * - 保存串行 + 版本锁：较早保存完成不会把较新编辑标 clean；失败保留输入并可见可重试。
 * - beginSend 同步加锁冻结完整 input 与清稿 expected（baseDraft+draft）。（清稿只走 shared.clearDraft CAS）
 * - confirmCleared/retryClearAfterVerify 用 clearDraft(key,[baseDraft,draft]) 取得持久化确认：
 *   冲突时保留新版磁盘草稿与原锁（供查看/采用），绝不擦掉别人更新的草稿。
 * - 所有 attempt 操作以 handle（key+attemptId）定位并核对，避免旧结果污染新草稿。
 * - cleared 只在本地空草稿保存成功时置 true，后续错误不清除；只读对账据 cleared+确定终态结束 attempt。
 * - 内部最小订阅集合：旧异步结束后通知新挂载视图。
 */
export function useDrafts(opts: {
  api: DesktopViewApi;
  identity: DesktopIdentity | null;
  target: { kind: 'primary' | 'room'; id: string };
}): DraftWidgetState {
  const { api, identity, target } = opts;
  const [key, setKey] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<DesktopDraftFileRef[]>([]);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<DraftAttempt | null>(null);
  const [savePaused, setSavePaused] = useState(false);
  const [conflict, setConflict] = useState<DraftSnapshot | null>(null);
  const keyRef = useRef<string | null>(null);
  keyRef.current = key;
  const pendingBuf = useRef<DraftSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!identity) {
      setKey(null);
      setError(null);
      return;
    }
    api.draftKey(identity, target).then((k) => {
      if (!cancelled) setKey(k);
    }).catch((e) => {
      if (!cancelled) {
        setKey(null);
        setError('草稿键获取失败：' + errText(e));
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, identity, target.kind, target.id]);

  useEffect(() => {
    if (!key) return;
    const mem = getMem(key);
    if (pendingBuf.current) {
      mem.text = pendingBuf.current.text;
      mem.files = pendingBuf.current.files;
      mem.attachments = pendingBuf.current.attachments ?? [];
      mem.dirty = true;
      pendingBuf.current = null;
      setDirty(true);
    } else if (!mem.attempt && mem.text === '' && mem.files.length === 0 && mem.attachments.length === 0 && !mem.dirty) {
      const saved = api.snapshot?.state.drafts[key];
      if (saved) {
        mem.text = saved.text;
        mem.files = [...saved.files];
        mem.attachments = saved.attachments ? saved.attachments.map((a) => ({ ...a })) : [];
        mem.savedVersion = mem.version;
      }
    }
    setText(mem.text);
    setFiles([...mem.files]);
    setAttachments([...mem.attachments]);
    setDirty(mem.dirty);
    setError(mem.lastError);
    setAttempt(mem.attempt ? { ...mem.attempt, input: { ...mem.attempt.input } } : null);
    setBusy(isMidFlight(mem));
    setSavePaused(mem.savePaused);
    setConflict(mem.conflict);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!key) return;
    return subscribe(key, () => {
      const mem = getMem(key);
      setText(mem.text);
      setFiles([...mem.files]);
      setAttachments([...mem.attachments]);
      setDirty(mem.dirty);
      setError(mem.lastError);
      setAttempt(mem.attempt ? { ...mem.attempt, input: { ...mem.attempt.input } } : null);
      setBusy(isMidFlight(mem));
      setSavePaused(mem.savePaused);
      setConflict(mem.conflict);
    });
  }, [key]);

  /** 排队在途保存；调用方已同步加锁，这里只等待链排空。 */
  const waitQuiet = useCallback(async (handle: DraftHandle): Promise<void> => {
    const cur = currentAttempt(handle);
    if (!cur) return;
    try {
      if (cur.mem.chain) await cur.mem.chain;
    } catch { /* chain 已吞错，不泄漏 */ }
  }, []);

  /** 保存具体 capture 的 key/内容/版本；attempt 存在时跳过（不写回冻结/旧内容）；savePaused 时一律跳过（含 force）。 */
  const persist = useCallback((k: string, content: DraftSnapshot, versionAtSchedule: number, force: boolean): Promise<void> => {
    if (!k) return Promise.resolve();
    const mem = getMem(k);
    if (!mem.chain) mem.chain = Promise.resolve();
    const run = mem.chain.then(async () => {
      // 排队期间前一次保存可能已置暂停：已入队的普通/卸载 force 保存也必须遵守，
      // 否则会用读回的新 revision 覆盖更新的磁盘草稿。
      if (mem.savePaused) return;
      if (mem.attempt && !force) return; // 发送 attempt 冻结中：不让迟到 autosave 写回旧草稿
      await api.saveDraft(k, {
        text: content.text,
        files: [...content.files],
        ...(content.attachments?.length ? { attachments: content.attachments.map((a) => ({ ...a })) } : {}),
      } satisfies DesktopDraftEntry);
      mem.savedVersion = Math.max(mem.savedVersion, versionAtSchedule);
      if (mem.version <= mem.savedVersion) {
        mem.dirty = false;
        mem.lastError = null;
        setDirty(false);
        setError(null);
      }
    }).catch((e) => {
      mem.dirty = true;
      if (isDraftConflict(e)) {
        // 冲突：暂停自动写（含 unmount force），保留本地编辑与新版草稿供显式选择。
        mem.savePaused = true;
        mem.conflict = latestPersistedDraft(api, k);
        mem.lastError = '草稿冲突：磁盘草稿已被更新，自动保存已暂停（本地输入保留）。';
      } else {
        mem.lastError = '草稿保存失败，已保留本地编辑。' + errText(e);
      }
      setDirty(true);
      setSavePaused(mem.savePaused);
      setConflict(mem.conflict);
      setError(mem.lastError);
      api.reportError(e);
    });
    mem.chain = run.then(() => undefined, () => undefined);
    return run;
  }, [api]);

  const persistRef = useRef(persist);
  persistRef.current = persist;

  const scheduleAutoSave = useCallback(() => {
    const k = keyRef.current;
    if (!k) return;
    const mem = getMem(k);
    if (mem.savePaused) {
      // 冲突未解决：不能带新 revision 自动重写别人的草稿；等显式动作。
      mem.dirty = true;
      setDirty(true);
      notify(k);
      return;
    }
    if (mem.timer !== null) window.clearTimeout(mem.timer);
    const v = ++mem.version;
    mem.dirty = true;
    setDirty(true);
    const content = { text: mem.text, files: [...mem.files], attachments: [...mem.attachments] };
    mem.timer = window.setTimeout(() => {
      mem.timer = null;
      void persist(k, content, v, false);
    }, 700);
  }, [persist]);

  const editText = useCallback((v: string) => {
    const k = keyRef.current;
    const mem = k ? getMem(k) : null;
    if (mem && mem.attempt) return; // attempt 未结束：不可修改/生成新 ID
    setText(v);
    if (mem) {
      mem.text = v;
    } else {
      const prev = pendingBuf.current ?? { text: '', files: [], attachments: [] };
      pendingBuf.current = { text: v, files: prev.files, attachments: prev.attachments };
    }
    scheduleAutoSave();
  }, [scheduleAutoSave]);

  const addFile = useCallback((ref: DesktopDraftFileRef) => {
    const k = keyRef.current;
    const mem = k ? getMem(k) : null;
    if (mem && mem.attempt) return;
    if (mem) {
      mem.files = [...mem.files, ref];
      setFiles(mem.files);
    } else {
      const prev = pendingBuf.current ?? { text: '', files: [], attachments: [] };
      pendingBuf.current = { text: prev.text, files: [...prev.files, ref], attachments: prev.attachments };
      setFiles(pendingBuf.current.files);
    }
    scheduleAutoSave();
  }, [scheduleAutoSave]);

  const removeFile = useCallback((index: number) => {
    const k = keyRef.current;
    const mem = k ? getMem(k) : null;
    if (mem && mem.attempt) return;
    if (mem) {
      mem.files = mem.files.filter((_, i) => i !== index);
      setFiles(mem.files);
    } else {
      const prev = pendingBuf.current ?? { text: '', files: [], attachments: [] };
      pendingBuf.current = { text: prev.text, files: prev.files.filter((_, i) => i !== index), attachments: prev.attachments };
      setFiles(pendingBuf.current.files);
    }
    scheduleAutoSave();
  }, [scheduleAutoSave]);

  const addAttachment = useCallback((att: ImageAttachment, expectedKey?: string): boolean => {
    const k = keyRef.current;
    // 原子归属校验：发起时冻结的 key 与当前 keyRef 必须一致，否则结果写入新 Bot 的草稿。
    if (expectedKey !== undefined && k !== expectedKey) return false;
    const mem = k ? getMem(k) : null;
    if (mem && mem.attempt) return false;
    const copy = { ...att };
    if (mem) {
      if (mem.attachments.some((a) => a.id === att.id)) return false;
      if (mem.attachments.length >= 4) return false;
      mem.attachments = [...mem.attachments, copy];
      setAttachments(mem.attachments);
    } else {
      const prev = pendingBuf.current ?? { text: '', files: [], attachments: [] };
      const prevAtt = prev.attachments ?? [];
      if (prevAtt.some((a) => a.id === att.id)) return false;
      if (prevAtt.length >= 4) return false;
      pendingBuf.current = { text: prev.text, files: prev.files, attachments: [...prevAtt, copy] };
      setAttachments(pendingBuf.current.attachments ?? []);
    }
    scheduleAutoSave();
    return true;
  }, [scheduleAutoSave]);

  const removeAttachment = useCallback((index: number) => {
    const k = keyRef.current;
    const mem = k ? getMem(k) : null;
    if (mem && mem.attempt) return;
    if (mem) {
      mem.attachments = mem.attachments.filter((_, i) => i !== index);
      setAttachments(mem.attachments);
    } else {
      const prev = pendingBuf.current ?? { text: '', files: [], attachments: [] };
      pendingBuf.current = { text: prev.text, files: prev.files, attachments: (prev.attachments ?? []).filter((_, i) => i !== index) };
      setAttachments(pendingBuf.current.attachments ?? []);
    }
    scheduleAutoSave();
  }, [scheduleAutoSave]);

  const retrySave = useCallback(() => {
    const k = keyRef.current;
    if (!k) return;
    const mem = getMem(k);
    if (mem.attempt) return;
    // 显式"保存当前编辑"是解除暂停的唯一普通草稿途径；再冲突则重新暂停。
    mem.savePaused = false;
    mem.conflict = null;
    setSavePaused(false);
    setConflict(null);
    void persist(k, { text: mem.text, files: [...mem.files], attachments: [...mem.attachments] }, mem.version, true);
  }, [persist]);

  /** 同步加锁 + 冻结完整输入与清稿 expected（首 await 前）。 */
  const beginSend = useCallback((input: PendingEnqueueInput): { key: string; handle: DraftHandle; attempt: DraftAttempt } | null => {
    const k = keyRef.current;
    if (!k) return null;
    if (!identity) return null;
    if (input.kind === 'primary' ? !input.requestId : !input.messageId) return null;
    // 图片-only 提交允许 text 为空；仍要求 kind 对应业务 ID。
    const primaryInput = input.kind === 'primary' ? input : null;
    const hasAttachments = primaryInput ? (primaryInput.attachments?.length ?? 0) > 0 : false;
    if (!input.text.trim() && !hasAttachments) return null;
    const mem = getMem(k);
    if (mem.attempt) return null;
    // 未解决的草稿冲突下不允许发送：否则清稿 expected 会包含别人更新的版本。
    if (mem.savePaused) return null;
    if (mem.timer !== null) {
      window.clearTimeout(mem.timer);
      mem.timer = null;
    }
    const attemptId = crypto.randomUUID();
    const persisted = latestPersistedDraft(api, k);
    const attemptRecord: DraftAttempt = {
      id: attemptId,
      owner: { ...identity },
      kind: input.kind,
      phase: 'locked',
      input: { ...input },
      pendingId: null,
      error: null,
      cleared: false,
      baseDraft: persisted ? copyDraft(persisted) : { text: '', files: [] },
      draft: {
        text: mem.text,
        files: mem.files.map((f) => ({ ...f })),
        ...(mem.attachments.length ? { attachments: mem.attachments.map((a) => ({ ...a })) } : {}),
      },
    };
    mem.attempt = attemptRecord;
    mem.conflict = null;
    setConflict(null);
    setAttempt({ ...attemptRecord, input: { ...attemptRecord.input } });
    setBusy(true);
    notify(k);
    // 返回实际冻结副本：composer 只发送这份 input，await 后不重组身份/replyTo。
    return { key: k, handle: { key: k, attemptId }, attempt: { ...attemptRecord, input: { ...attemptRecord.input } } };
  }, [api, identity]);

  const setPending = useCallback((handle: DraftHandle, pendingId: string) => {
    const cur = currentAttempt(handle);
    if (!cur) return;
    cur.mem.attempt = { ...cur.attempt, phase: 'enqueued', pendingId };
    setAttempt(cur.mem.attempt);
    notify(handle.key);
  }, []);

  /**
   * 用 shared.clearDraft(key,[baseDraft,draft]) 做持久化 CAS：只有匹配空草稿或冻结版本才允许清空；
   * 冲突时保留新版磁盘草稿与原锁（供展示/采用），非冲突失败保留原内容与锁。
   */
  const confirmCleared = useCallback(async (handle: DraftHandle): Promise<'cleared' | 'conflict' | 'failed'> => {
    const started = currentAttempt(handle);
    if (!started) return 'failed';
    const expected: readonly DesktopDraftEntry[] = [
      copyDraft(started.attempt.baseDraft),
      copyDraft(started.attempt.draft),
    ];
    try {
      await api.clearDraft(handle.key, expected);
    } catch (e) {
      const failed = currentAttempt(handle);
      const conflictWith = isDraftConflict(e) ? latestPersistedDraft(api, handle.key) : null;
      if (failed) {
        failed.mem.conflict = conflictWith;
        failed.mem.attempt = { ...failed.attempt, phase: 'failed', error: '草稿尚未清空（草稿冲突）。' };
        setAttempt(failed.mem.attempt);
        setConflict(conflictWith);
        setBusy(false);
        notify(handle.key);
      }
      api.reportError(e);
      return isDraftConflict(e) ? 'conflict' : 'failed';
    }
    // 写入成功才清内存/标 clean；保存期间不得被新 attempt 覆盖
    const cur = currentAttempt(handle);
    if (!cur) return 'cleared';
    const mem = cur.mem;
    mem.text = '';
    mem.files = [];
    mem.attachments = [];
    mem.dirty = false;
    mem.lastError = null;
    mem.conflict = null;
    mem.version += 1;
    mem.savedVersion = mem.version;
    mem.attempt = { ...cur.attempt, phase: 'cleared', cleared: true };
    setText('');
    setFiles([]);
    setAttachments([]);
    setDirty(false);
    setError(null);
    setConflict(null);
    setAttempt(mem.attempt);
    setBusy(true);
    notify(handle.key);
    return 'cleared';
  }, [api]);

  const finishSend = useCallback((handle: DraftHandle) => {
    const cur = currentAttempt(handle);
    if (!cur) return;
    verifiedRecords.delete(cur.attempt.id);
    cur.mem.attempt = null;
    setAttempt(null);
    setBusy(false);
    notify(handle.key);
  }, []);

  const markNotSent = useCallback((handle: DraftHandle, errorText: string) => {
    const cur = currentAttempt(handle);
    if (!cur) return;
    // 已有队列记录时不得声称未入队：降级为 unconfirmed 并保留原 ID。
    cur.mem.attempt = cur.attempt.pendingId
      ? { ...cur.attempt, phase: 'unconfirmed', error: errorText }
      : { ...cur.attempt, phase: 'not-sent', error: errorText };
    setAttempt(cur.mem.attempt);
    setBusy(false);
    notify(handle.key);
  }, []);

  const markFailed = useCallback((handle: DraftHandle, errorText: string) => {
    const cur = currentAttempt(handle);
    if (!cur) return;
    cur.mem.attempt = { ...cur.attempt, phase: 'failed', error: errorText };
    setAttempt(cur.mem.attempt);
    setBusy(false);
    notify(handle.key);
  }, []);

  const markUnconfirmed = useCallback((handle: DraftHandle) => {
    const cur = currentAttempt(handle);
    if (!cur) return;
    // cleared/input/owner/pendingId 原样保留，只改阶段。
    cur.mem.attempt = { ...cur.attempt, phase: 'unconfirmed' };
    setAttempt(cur.mem.attempt);
    setBusy(false);
    notify(handle.key);
  }, []);

  /**
   * 只读对账。返回 ReconcileOutcome：
   * - finished：查到确定受理/终态且草稿已清空 → 已结束本地 attempt。
   * - kept：查到记录但状态未知/未终态 → 保持锁。
   * - ready-clear-retry：查到记录且本地清空失败 → 允许显式重试本地清空。
   * - unconfirmed：查不到 → 保持未确认与锁（绝不重新 enqueue/换 ID）。
   */
  const reconcile = useCallback(async (handle: DraftHandle): Promise<ReconcileOutcome> => {
    const started = currentAttempt(handle);
    if (!started) {
      return {
        action: 'kept', found: false, recordId: null, recordState: null,
        note: '本地 attempt 已结束或被新发送替换，未查询。',
      };
    }
    const owner = started.attempt.owner;
    const input = started.attempt.input;
    const current = api.identity;
    if (
      !current ||
      current.profileId !== owner.profileId ||
      (current.kind === 'local' && current.targetDeviceId !== owner.targetDeviceId) ||
      current.kind !== owner.kind
    ) {
      // 冻结 owner 的 generation 在断开/重连后必然过期；先核对同 profile/target/kind，不匹配保持锁。
      return {
        action: 'kept', found: false, recordId: null, recordState: null,
        note: '当前连接与冻结 attempt 不同（profile/target/kind）；请回到原连接后对账，保持锁与冻结 ID。',
      };
    }
    // 只读查询用当前 generation，冻结 owner/input 不变。
    const queryIdentity: DesktopIdentity = api.identityForTarget(owner.targetDeviceId);
    const pendingId = started.attempt.pendingId;
    let found: PendingRecord | null = null;
    let queryError: string | null = null;

    if (pendingId) {
      try {
        found = await api.pending(queryIdentity, 'pending_get', { id: pendingId });
      } catch (e) {
        api.reportError(e);
        queryError = errText(e);
      }
      // sending/unconfirmed 或本地未命中：显式只读 reconcile（需 transport），绝不 send。
      if ((!found || found.state === 'sending' || found.state === 'unconfirmed') && api.transportConnected) {
        try {
          found = await api.pending(queryIdentity, 'pending_reconcile', { id: pendingId });
        } catch (e) {
          api.reportError(e);
          queryError = errText(e);
        }
      }
    }

    let exhausted = true;
    if (!found) {
      // 未知 pending.id：pending_list 分页按冻结业务 ID + 文本/replyTo 匹配，不 enqueue/不换 ID。
      let cursor: PendingCursor | null = null;
      exhausted = false;
      for (let pageNo = 0; pageNo < 20; pageNo += 1) {
        let page: PendingListPage;
        try {
          page = await api.pending(queryIdentity, 'pending_list', { options: { limit: 50, cursor } });
        } catch (e) {
          api.reportError(e);
          queryError = errText(e);
          break;
        }
        const hit: PendingRecord | undefined = page.items.find((item) => matchesInput(item, input));
        if (hit) {
          found = hit;
          break;
        }
        cursor = page.nextCursor;
        if (!cursor) {
          exhausted = true;
          break;
        }
      }
    }

    // 应用前重检 handle：对账期间不得覆盖新 attempt。
    const cur = currentAttempt(handle);
    if (!cur) {
      return {
        action: 'kept', found: found !== null, recordId: found ? found.id : null,
        recordState: found ? found.state : null,
        note: '查询结果返回时本地 attempt 已变化，未应用；保持原记录信息。',
      };
    }

    if (!found) {
      return {
        action: 'unconfirmed', found: false, recordId: null, recordState: null,
        note: queryError
          ? `查询失败（${queryError}）；保持未确认与锁，绝不自动补发。`
          : exhausted
            ? '队列全部分页中未命中原记录；保持未确认与锁，绝不自动补发。'
            : '已检索 20 页仍未命中（队列可能更长，未遍历完）；保持未确认与锁，绝不自动补发。',
      };
    }

    const state = recordStateOf(found);
    const definite = state === 'accepted' || state === 'rejected';
    verifiedRecords.set(cur.attempt.id, { recordId: found.id, definite });
    // 采纳发现的原记录 id（只在缺省或不同时更新，input/owner 不变）。
    if (cur.attempt.pendingId !== found.id) {
      cur.mem.attempt = { ...cur.attempt, pendingId: found.id };
      setAttempt(cur.mem.attempt);
      notify(handle.key);
    }
    if (cur.attempt.cleared && definite) {
      // 已确认本地清空且原记录确定受理/终态：只结束本地 attempt，不自动发送。
      finishSend(handle);
      return { action: 'finished', found: true, recordId: found.id, recordState: state, note: null };
    }
    if (!cur.attempt.cleared) {
      if (cur.mem.conflict) {
        // 磁盘上有更新版本：不能重试清空（会擦掉新版），改为显式“采用新版并结束旧尝试”。
        return {
          action: 'kept', found: true, recordId: found.id, recordState: state,
          note: `对账：已核实原记录 ${found.id}（${state}）；草稿冲突尚未解决，请选“保留新版草稿，结束旧尝试”，不会清磁盘也不会发送。`,
        };
      }
      // 清稿失败/未清：显示原记录，允许显式重试本地清空。
      return { action: 'ready-clear-retry', found: true, recordId: found.id, recordState: state, note: null };
    }
    return { action: 'kept', found: true, recordId: found.id, recordState: state, note: null };
  }, [api, finishSend]);

  const releaseIfNotSent = useCallback((handle: DraftHandle): { ok: boolean; error?: string } => {
    const cur = currentAttempt(handle);
    if (!cur) return { ok: false, error: 'attempt 不存在或已结束' };
    // 已有队列记录 / 已入队成功后任何阶段都不得释放，避免误解锁后换 ID 重发。
    if (cur.attempt.pendingId) return { ok: false, error: '已有队列记录，不允许释放编辑' };
    if (cur.attempt.phase !== 'not-sent') {
      return { ok: false, error: '仅确定未入队（not-sent）可释放编辑' };
    }
    verifiedRecords.delete(cur.attempt.id);
    cur.mem.attempt = null;
    setAttempt(null);
    setBusy(false);
    notify(handle.key);
    return { ok: true };
  }, []);

  const retryClearAfterVerify = useCallback(async (handle: DraftHandle): Promise<'cleared' | 'conflict' | 'failed'> => {
    const cur = currentAttempt(handle);
    if (!cur) return 'failed';
    // 必须有本轮只读对账确认过的原记录依据，不能仅凭 pendingId 非空。
    const verified = verifiedRecords.get(cur.attempt.id);
    if (!verified || verified.recordId !== cur.attempt.pendingId) return 'failed';
    // 同样走 clearDraft CAS：磁盘出现更新版本时再次冲突，绝不清除新版。
    const expected: readonly DesktopDraftEntry[] = [
      copyDraft(cur.attempt.baseDraft),
      copyDraft(cur.attempt.draft),
    ];
    try {
      await api.clearDraft(handle.key, expected);
    } catch (e) {
      const conflictWith = isDraftConflict(e) ? latestPersistedDraft(api, handle.key) : null;
      const failed = currentAttempt(handle);
      if (failed) {
        failed.mem.conflict = conflictWith;
        failed.mem.attempt = { ...failed.attempt, error: '草稿尚未清空。' };
        setAttempt(failed.mem.attempt);
        setConflict(conflictWith);
      }
      api.reportError(e);
      return isDraftConflict(e) ? 'conflict' : 'failed';
    }
    // 保存后重检同一 handle 再更新共享草稿，不覆盖新 attempt。
    const again = currentAttempt(handle);
    if (!again) return 'failed';
    again.mem.text = '';
    again.mem.files = [];
    again.mem.attachments = [];
    again.mem.dirty = false;
    again.mem.lastError = null;
    again.mem.conflict = null;
    again.mem.version += 1;
    again.mem.savedVersion = again.mem.version;
    again.mem.attempt = { ...again.attempt, phase: 'cleared', cleared: true };
    setText('');
    setFiles([]);
    setAttachments([]);
    setDirty(false);
    setError(null);
    setConflict(null);
    setAttempt(again.mem.attempt);
    setBusy(true);
    notify(handle.key);
    if (verified.definite) {
      // 原记录已确定受理/终态：结束本地 attempt（只做本地清空，不触发远程 send）。
      finishSend(handle);
    }
    return 'cleared';
  }, [api, finishSend]);

  /**
   * 草稿冲突 + 原记录已只读核实后的明确动作：
   * 只把本地编辑改成本轮读到的新版草稿并结束旧 attempt；不清磁盘、不发送，原队列记录保留。
   */
  const adoptNewerDraftAndFinish = useCallback((handle: DraftHandle): { ok: boolean; error?: string } => {
    const cur = currentAttempt(handle);
    if (!cur) return { ok: false, error: 'attempt 不存在或已结束' };
    const newer = cur.mem.conflict;
    if (!newer) return { ok: false, error: '尚未读到新版持久草稿，请先查询原记录' };
    const verified = verifiedRecords.get(cur.attempt.id);
    if (!verified || !cur.attempt.pendingId || verified.recordId !== cur.attempt.pendingId) {
      return { ok: false, error: '请先只读核实原队列记录，未知记录不能释放' };
    }
    cur.mem.text = newer.text;
    cur.mem.files = newer.files.map((f) => ({ ...f }));
    cur.mem.attachments = (newer.attachments ?? []).map((a) => ({ ...a }));
    cur.mem.dirty = false;
    cur.mem.lastError = null;
    cur.mem.conflict = null;
    cur.mem.savePaused = false;
    cur.mem.version += 1;
    cur.mem.savedVersion = cur.mem.version;
    cur.mem.attempt = null;
    verifiedRecords.delete(cur.attempt.id);
    setText(cur.mem.text);
    setFiles(cur.mem.files);
    setAttachments(cur.mem.attachments);
    setDirty(false);
    setError(null);
    setConflict(null);
    setSavePaused(false);
    setAttempt(null);
    setBusy(false);
    notify(handle.key);
    return { ok: true };
  }, []);

  const adoptPersistedDraft = useCallback(async (key: string): Promise<{ ok: boolean; error?: string }> => {
    const mem = getMem(key);
    if (mem.chain) await mem.chain;
    if (keyRef.current !== key) return { ok: false, error: '当前聊天已切换' };
    if (mem.attempt) return { ok: false, error: '发送尝试仍被锁定' };
    const snapshot = api.snapshot;
    if (!snapshot) return { ok: false, error: '持久草稿尚未加载' };
    const saved = snapshot.state.drafts[key] ?? { text: '', files: [] };
    if (mem.timer !== null) { window.clearTimeout(mem.timer); mem.timer = null; }
    mem.text = saved.text;
    mem.files = saved.files.map(file => ({ ...file }));
    mem.attachments = (saved.attachments ?? []).map(a => ({ ...a }));
    mem.dirty = false;
    mem.lastError = null;
    mem.conflict = null;
    mem.savePaused = false;
    mem.version += 1;
    mem.savedVersion = mem.version;
    setText(mem.text);
    setFiles([...mem.files]);
    setAttachments([...mem.attachments]);
    setDirty(false);
    setError(null);
    setConflict(null);
    setSavePaused(false);
    notify(key);
    return { ok: true };
  }, [api]);

  useEffect(() => {
    return () => {
      const k = keyRef.current;
      if (!k) return;
      const mem = getMem(k);
      if (mem.timer !== null) {
        window.clearTimeout(mem.timer);
        mem.timer = null;
      }
      if (mem.attempt) return; // 发送 attempt 冻结中：不写回旧内容
      if (mem.savePaused) return; // 冲突未解决：即使卸载也不自动覆盖别人更新的草稿
      if (mem.dirty) void persistRef.current(k, { text: mem.text, files: [...mem.files], attachments: [...mem.attachments] }, mem.version, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    key,
    text,
    files,
    attachments,
    dirty,
    busy,
    error,
    savePaused,
    conflict,
    attempt,
    editText,
    addFile,
    removeFile,
    addAttachment,
    removeAttachment,
    retrySave,
    beginSend,
    waitQuiet,
    setPending,
    confirmCleared,
    finishSend,
    markNotSent,
    markFailed,
    markUnconfirmed,
    reconcile,
    releaseIfNotSent,
    retryClearAfterVerify,
    adoptNewerDraftAndFinish,
    adoptPersistedDraft,
  };
}
