import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Mic, RefreshCw, Square, X, Zap } from 'lucide-react';
import {
  BotHost,
  type HostSubmission,
  type QueuedTurnItem,
  type TurnDeliveryMode,
  type WithdrawnTurnItem,
} from '../native';
import { mobileHaptic } from '../native/tauri-host';
import { useDrafts } from '../../../desktop/web/src/drafts';
import type { DesktopDraftEntry, DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import type {
  ImageAttachment,
  PendingCursor,
  PendingListPage,
  PendingRecord,
} from '../../../host-core/index.js';
import {
  canSteerBotActivity,
  resolveComposerActionKind,
  shouldShowComposerStop,
  type BotActivity,
} from '../botActivity';
import {
  extractEditableUserText,
  mergeQueuedStripItems,
  resolveAttachmentMetasByIds,
  type UnifiedQueuedStripItem,
} from '../composerFlowControl';
import { ComposerEditBanner, PendingQueueStrip } from '../ComposerFlowStrips';
import {
  IMAGE_MAX_COUNT,
  IMAGE_MAX_TOTAL_BYTES,
  ImageAttachmentThumb,
  ImagePickError,
  SentAttachments,
  attachmentFileName,
  attachmentIdOf,
  extractPastedImageFiles,
  normalizeImageFile,
  pickImagesFromInput,
  type AttachmentFetcher,
  type ImageAttachmentData,
  type PickedImageSource,
} from '../imageAttachments';
import { errorText, useText } from '../ui';
import { LabelStack, SmoothExpand } from '../layout';
import { useNotice, type NoticeTone } from '../notice';
import { SendButtonIcon } from '../SendButtonIcon';
import {
  parseSlashCommand,
  useSlashAutocomplete,
  uuid,
  type SlashCommandName,
} from '../hub/shared';
import {
  ActionSlip,
  Button,
  ConditionDock,
  ConfirmDialog,
  InlineBanner,
  type ConditionDockItem,
} from '../components/ui';
import { ComposerPlusMenu, ComposerSlashPopover } from '../components/ComposerPopovers';
import {
  isCoarsePointer,
  useIsCoarsePointer,
  type ActiveEditingTurn,
  type ChatPending,
  type RemoteTaskContext,
} from './types';

type FieldSizingCSSProperties = CSSProperties & {
  fieldSizing?: 'content' | 'fixed';
};

function supportsFieldSizingContent(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('field-sizing', 'content')
  );
}

export interface RemotePendingComposerProps {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  botId: string;
  botRole: string;
  activity: BotActivity;
  turnAdmission?: { requestId: string; phase: string } | null;
  liveQueuedItems?: readonly QueuedTurnItem[];
  editingTurn?: ActiveEditingTurn | null;
  editSubmitting?: boolean;
  onChangeEditTurn?: (patch: Partial<Pick<ActiveEditingTurn, 'text' | 'attachments'>>) => void;
  onCancelEditTurn?: () => void;
  onSubmitEditTurn?: () => void;
  /** 统一活动状态允许停止（排队/准备/运行/让位/失败受理）。 */
  canStop?: boolean;
  /** 停止已受理、正在确认；发送/草稿/上传都不解除它。 */
  stopping?: boolean;
  online: boolean;
  onOffline(): void;
  composerMenuOpen: boolean;
  onToggleComposerMenu(): void;
  /** 执行 /clear 与 /compact；true 表示服务端已成功（可清命令草稿），false 表示 UI 已切走后不再报错的过期结果。 */
  onRunCommand(command: SlashCommandName): Promise<boolean>;
  /** 顶栏菜单等 Host 侧发起的命令执行中：锁住输入与发送，避免绕过。 */
  commandBusy?: boolean;
  /** 停止此 Bot：调用方等待 Promise；失败由调用方统一提示，此处不吞错。 */
  onAbort(): Promise<unknown>;
  onAccepted(receipt: HostSubmission): void;
  onStarted(requestId: string, text: string, draft: DesktopDraftEntry, delivery?: TurnDeliveryMode): void;
  onPersist(requestId: string): boolean;
  onQueued(requestId: string, pendingId: string): void;
  pending?: ChatPending;
  fallbackDraft: string;
  onFallbackTransferred(): void;
  blocked: boolean;
  onUnconfirmed(requestId: string): void;
  onNotSent(requestId: string): void;
  onUserSend?(): void;
  pendingQuote?: { seq: number; text: string; mode?: 'quote' | 'append' } | null;
  onConsumedQuote?: () => void;
  taskContext?: RemoteTaskContext;
  onTaskMessageSent?: (rawText: string, capturedContext?: RemoteTaskContext) => void;
  floatingDockContainer?: HTMLElement | null;
  onDockItemsChange?: (items: ConditionDockItem[]) => void;
  hideInlineEditBanner?: boolean;
}

export function RemotePendingComposer({
  api,
  identity,
  botId,
  botRole,
  activity,
  turnAdmission = null,
  liveQueuedItems,
  editingTurn = null,
  editSubmitting = false,
  onChangeEditTurn,
  onCancelEditTurn,
  onSubmitEditTurn,
  canStop = false,
  stopping = false,
  online,
  onOffline,
  composerMenuOpen,
  onToggleComposerMenu,
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
  onUserSend,
  pendingQuote,
  onConsumedQuote,
  taskContext,
  onTaskMessageSent,
  floatingDockContainer,
  onDockItemsChange,
  hideInlineEditBanner = false,
}: RemotePendingComposerProps) {
  const t = useText();
  const { notify, dismiss } = useNotice();
  const coarsePointer = useIsCoarsePointer();
  const supportsFieldSizing = useMemo(() => supportsFieldSizingContent(), []);
  const textareaStyle = useMemo<FieldSizingCSSProperties | undefined>(() => {
    if (!supportsFieldSizing) return undefined;
    return {
      fieldSizing: 'content',
      height: 'auto',
      minHeight: '36px',
      maxHeight: '110px',
    };
  }, [supportsFieldSizing]);
  const target = useMemo(() => ({ kind: 'primary' as const, id: botId }), [botId]);
  const drafts = useDrafts({ api, identity, target });
  const [noticeState, setNoticeState] = useState<{ text: string; tone: NoticeTone; seq: number }>({
    text: '',
    tone: 'error',
    seq: 0,
  });
  const setNotice = useCallback((text: string, tone: NoticeTone = 'error') => {
    setNoticeState(prev => ({ text, tone, seq: text ? prev.seq + 1 : prev.seq }));
  }, []);
  const [imageErrorState, setImageErrorState] = useState<{ text: string; seq: number }>({
    text: '',
    seq: 0,
  });
  const setImageError = useCallback((text: string) => {
    setImageErrorState(prev => ({ text, seq: text ? prev.seq + 1 : prev.seq }));
  }, []);
  const [stopErrorState, setStopErrorState] = useState<{ text: string; seq: number }>({
    text: '',
    seq: 0,
  });
  const setStopError = useCallback((text: string) => {
    setStopErrorState(prev => ({ text, seq: text ? prev.seq + 1 : prev.seq }));
  }, []);
  const [queueBusy, setQueueBusy] = useState(false);
  const [outboxPendingItems, setOutboxPendingItems] = useState<PendingRecord[]>([]);
  /** 选图/上传在途：禁重复选择与发送（state 驱动 UI disabled）；归属冻结到发起时的 identity/botId/draftKey。 */
  const [imageUploading, setImageUploading] = useState(false);
  const remoteFetcher = useMemo<AttachmentFetcher>(() => {
    return async (attachmentId) => api.call(identity, 'getAttachment', { botId, attachmentId }) as Promise<ImageAttachmentData>;
  }, [api, identity, botId]);

  const botNoticeKey = taskContext?.botKey || `${identity.profileId}:${identity.targetDeviceId}:${botId}`;
  const errorNoticeId = `remote-composer-error:${botNoticeKey}`;
  const imageErrorNoticeId = `remote-composer-image-error:${botNoticeKey}`;
  const savePausedNoticeId = `remote-composer-save-paused:${botNoticeKey}`;
  const unsupportedNoticeId = `remote-composer-unsupported:${botNoticeKey}`;
  const retrySaveRef = useRef(drafts.retrySave);
  retrySaveRef.current = drafts.retrySave;

  const effectiveText = editingTurn ? editingTurn.text : drafts.text;
  const effectiveAttachments = editingTurn ? editingTurn.attachments : drafts.attachments;
  const editingTurnRef = useRef(editingTurn);
  editingTurnRef.current = editingTurn;
  const [editBannerMounted, setEditBannerMounted] = useState(Boolean(editingTurn));

  useEffect(() => {
    if (editingTurn) {
      setEditBannerMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setEditBannerMounted(false), 240);
    return () => window.clearTimeout(timer);
  }, [editingTurn]);

  const nonPausedDraftError = drafts.savePaused ? '' : (drafts.error || '');
  const primaryErrorText = nonPausedDraftError || noticeState.text || stopErrorState.text;
  const primaryErrorTone: NoticeTone = nonPausedDraftError
    ? 'error'
    : noticeState.text
      ? noticeState.tone
      : 'error';
  const primaryErrorSeq = nonPausedDraftError
    ? 0
    : noticeState.text
      ? noticeState.seq
      : stopErrorState.seq;

  useEffect(() => {
    if (primaryErrorText) {
      notify({
        id: errorNoticeId,
        tone: primaryErrorTone,
        title: primaryErrorText,
      });
    } else {
      dismiss(errorNoticeId);
    }
  }, [primaryErrorText, primaryErrorTone, primaryErrorSeq, errorNoticeId, notify, dismiss]);

  useEffect(() => {
    if (imageErrorState.text) {
      notify({
        id: imageErrorNoticeId,
        tone: 'error',
        title: imageErrorState.text,
      });
    } else {
      dismiss(imageErrorNoticeId);
    }
  }, [imageErrorState.text, imageErrorState.seq, imageErrorNoticeId, notify, dismiss]);

  useEffect(() => {
    if (drafts.savePaused) {
      notify({
        id: savePausedNoticeId,
        tone: 'warning',
        title: drafts.error || t('草稿自动保存已暂停，本地输入已保留。', 'Draft autosave paused; local input retained.'),
        sticky: true,
        action: {
          label: t('重试保存草稿', 'Retry draft save'),
          onClick: () => retrySaveRef.current(),
        },
      });
    } else {
      dismiss(savePausedNoticeId);
    }
  }, [drafts.savePaused, drafts.error, savePausedNoticeId, notify, dismiss, t]);

  useEffect(() => {
    return () => {
      dismiss(errorNoticeId);
      dismiss(imageErrorNoticeId);
      dismiss(savePausedNoticeId);
      dismiss(unsupportedNoticeId);
    };
  }, [errorNoticeId, imageErrorNoticeId, savePausedNoticeId, unsupportedNoticeId, dismiss]);

  useEffect(() => {
    if (!pendingQuote) return;
    const insertion =
      pendingQuote.mode === 'append'
        ? pendingQuote.text
        : pendingQuote.text
            .split('\n')
            .slice(0, 6)
            .map(line => `> ${line}`)
            .join('\n') + '\n\n';
    const next = drafts.text ? `${drafts.text.trimEnd()}\n${insertion}` : insertion;
    drafts.editText(next);
    onConsumedQuote?.();
    requestAnimationFrame(() => textareaRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuote?.seq]);

  useEffect(() => {
    if (editingTurn?.entryId) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [editingTurn?.entryId]);

  const refreshOutboxPending = useCallback(async () => {
    try {
      const page = await api.pending(identity, 'pending_list', { options: { state: 'pending', limit: 50 } });
      setOutboxPendingItems(
        page.items.filter(
          item => item.kind === 'primary' && item.botId === botId && item.targetDeviceId === identity.targetDeviceId,
        ),
      );
    } catch {
      // Ignore local outbox read errors
    }
  }, [api, identity, botId]);

  useEffect(() => {
    void refreshOutboxPending();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshOutboxPending();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshOutboxPending]);

  const queuedStripItems = useMemo(() => {
    const items = mergeQueuedStripItems(liveQueuedItems, outboxPendingItems, botId, identity.targetDeviceId);
    const hiddenIds = new Set<string>();
    if (turnAdmission && turnAdmission.phase !== 'queued') {
      hiddenIds.add(turnAdmission.requestId);
    }
    if (activity.phase === 'preparing' && activity.requestId) {
      hiddenIds.add(activity.requestId);
    }
    return hiddenIds.size > 0 ? items.filter(item => !hiddenIds.has(item.requestId)) : items;
  }, [liveQueuedItems, outboxPendingItems, botId, identity.targetDeviceId, turnAdmission, activity.phase, activity.requestId]);

  /** Tauri（Android）界面才有原生选图/拍照；浏览器走 input type=file。 */
  const inTauriUi = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

  /** 上传选图到目标 Host 并把元数据加入草稿；归属冻结在发起时 identity/botId/draftKey。
   *  addAttachment 的 expectedKey 是原子 guard（keyRef 实时比较）：切换 Bot/身份后未完成批次中止，
   *  已上传结果不写新 scope 草稿。相同图片 id（content SHA-256）去重；去重后总数 ≤16，超限整体拒绝。 */
  const uploadRemoteImages = useCallback(async (sources: PickedImageSource[], targetEditEntryId?: number) => {
    const draftKey = drafts.key;
    if ((!draftKey && targetEditEntryId === undefined) || sources.length === 0) return;
    const frozenIdentity = { ...identity };
    const currentList = targetEditEntryId !== undefined
      ? (editingTurnRef.current?.entryId === targetEditEntryId ? editingTurnRef.current.attachments : [])
      : drafts.attachments;
    const existing = new Set(currentList.map((a) => a.id));
    const queued: { source: PickedImageSource; id: string }[] = [];
    for (const source of sources) {
      const id = await attachmentIdOf(source.data);
      if (existing.has(id)) continue;
      existing.add(id);
      queued.push({ source, id });
    }
    if (currentList.length + queued.length > IMAGE_MAX_COUNT) {
      throw new ImagePickError('IMAGE_TOO_MANY', t(`最多 ${IMAGE_MAX_COUNT} 张图片，本次未上传。`, `At most ${IMAGE_MAX_COUNT} images; nothing uploaded.`));
    }
    const totalBytes = currentList.reduce((sum, a) => sum + a.size, 0)
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
      if (targetEditEntryId !== undefined) {
        const cur = editingTurnRef.current;
        if (!cur || cur.entryId !== targetEditEntryId) return;
        if (!cur.attachments.some(a => a.id === (att as ImageAttachment).id)) {
          onChangeEditTurn?.({ attachments: [...cur.attachments, att as ImageAttachment] });
        }
      } else if (draftKey) {
        // expectedKey 原子校验：当前 key 已切换（新 Bot/重连/换代）时拒绝，中止剩余批次。
        if (!drafts.addAttachment(att as ImageAttachment, draftKey)) return;
      }
    }
  }, [api, identity, botId, drafts, onChangeEditTurn, t]);

  const pickRemoteImages = useCallback((source: 'photos' | 'camera', pastedFiles?: File[]) => {
    if (pastedFiles && pastedFiles.length === 0) return;
    const targetEditEntryId = editingTurnRef.current?.entryId;
    if (imageUploading || (!drafts.key && targetEditEntryId === undefined) || Boolean(drafts.attempt) || blocked || Boolean(commandBusy) || Boolean(editSubmitting)) return;
    setImageError('');
    const release = () => setImageUploading(false);
    const handleSources = async (sources: PickedImageSource[]) => {
      if (sources.length === 0) return;
      await uploadRemoteImages(sources, targetEditEntryId);
    };
    const handleFiles = async (files: File[]) => {
      const normalized = await Promise.all(files.map((file) => normalizeImageFile(file, file.name)));
      await handleSources(normalized);
    };
    setImageUploading(true);
    if (pastedFiles) {
      void handleFiles(pastedFiles)
        .catch((error) => { setImageError(errorText(error)); })
        .finally(release);
      return;
    }
    if (inTauriUi) {
      void BotHost.pickImages({ source }).then(
        (result) => handleSources(result.cancelled ? [] : result.images),
      )
        .catch((error) => { setImageError(errorText(error)); })
        .finally(release);
      return;
    }
    pickImagesFromInput({
      onPicked: async (files) => {
        try {
          await handleFiles(files);
        } catch (error) {
          setImageError(errorText(error));
        }
      },
      onSettled: release,
    });
  }, [imageUploading, drafts.key, drafts.attempt, blocked, commandBusy, editSubmitting, inTauriUi, uploadRemoteImages, setImageError]);
  const [confirmedConflict, setConfirmedConflict] = useState<{ requestId: string; pendingId: string; original: DesktopDraftEntry; handle?: { key: string; attemptId: string } }>();
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [slashBusy, setSlashBusy] = useState<SlashCommandName>();
  const slashBusyRef = useRef(false);
  const sending = useRef(false);
  const [sendingNow, setSendingNow] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRowRef = useRef<HTMLDivElement | null>(null);
  /** 停止与发送并存、独立：不被 attempt/上传/草稿/action.busy 锁禁，只防重复。 */
  const stopBusy = Boolean(stopping);
  const runAbort = async () => {
    if (stopBusy) return;
    setStopError('');
    try {
      await onAbort();
      void refreshOutboxPending();
    } catch (error) {
      setStopError(errorText(error));
    }
  };

  const recallRemoteQueuedItem = async (item: UnifiedQueuedStripItem, mergeIntoDraft = true) => {
    if (queueBusy) return;
    if (mergeIntoDraft && (drafts.attempt || blocked || fallbackDraft)) {
      setNotice(t('当前存在未确认草稿，请先处理后再撤回排队消息。', 'Resolve the unconfirmed draft before recalling queued messages.'), 'warning');
      return;
    }
    setQueueBusy(true);
    setNotice('');
    try {
      let withdrawn: WithdrawnTurnItem[] = [];
      if (item.source === 'outbox' && item.outboxRecord) {
        const cancelled = await api.pending(identity, 'pending_cancel', { id: item.outboxRecord.id });
        if (cancelled.state === 'rejected') {
          withdrawn = [{
            requestId: item.outboxRecord.requestId,
            text: item.outboxRecord.text,
            ...(item.outboxRecord.attachments?.length ? { attachments: item.outboxRecord.attachments } : {}),
            delivery: item.outboxRecord.delivery ?? 'followUp',
          }];
        }
      } else {
        if (!online || !api.transportConnected) {
          onOffline();
          return;
        }
        const res = await api.call(identity, 'withdrawQueued', { botId, requestId: item.requestId });
        withdrawn = res.withdrawn ?? [];
      }
      for (const w of withdrawn) {
        onNotSent(w.requestId);
      }
      if (mergeIntoDraft && withdrawn.length > 0) {
        const attachmentIds = withdrawn.flatMap(w => w.attachments ?? []);
        const resolvedAtts = await resolveAttachmentMetasByIds(
          attachmentIds,
          attachmentIds.length > 0 ? remoteFetcher : null,
        );
        drafts.mergeRecalled(
          withdrawn.map(w => extractEditableUserText(w.text)),
          resolvedAtts,
          drafts.key ?? undefined,
        );
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
      void refreshOutboxPending();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setQueueBusy(false);
    }
  };

  const recallAllRemoteQueued = async () => {
    if (queueBusy) return;
    if (drafts.attempt || blocked || fallbackDraft) {
      setNotice(t('当前存在未确认草稿，请先处理后再撤回排队消息。', 'Resolve the unconfirmed draft before recalling queued messages.'), 'warning');
      return;
    }
    setQueueBusy(true);
    setNotice('');
    try {
      const outboxWithdrawn: WithdrawnTurnItem[] = [];
      for (const rec of outboxPendingItems) {
        if (rec.kind !== 'primary') continue;
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
      let hostWithdrawn: WithdrawnTurnItem[] = [];
      if (online && api.transportConnected) {
        const res = await api.call(identity, 'withdrawQueued', { botId });
        hostWithdrawn = res.withdrawn ?? [];
      }
      const combined: WithdrawnTurnItem[] = [];
      const seen = new Set<string>();
      for (const w of [...hostWithdrawn, ...outboxWithdrawn]) {
        if (!w?.requestId || seen.has(w.requestId)) continue;
        seen.add(w.requestId);
        combined.push(w);
        onNotSent(w.requestId);
      }
      if (combined.length > 0) {
        const attachmentIds = combined.flatMap(w => w.attachments ?? []);
        const resolvedAtts = await resolveAttachmentMetasByIds(
          attachmentIds,
          attachmentIds.length > 0 ? remoteFetcher : null,
        );
        drafts.mergeRecalled(
          combined.map(w => extractEditableUserText(w.text)),
          resolvedAtts,
          drafts.key ?? undefined,
        );
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
      void refreshOutboxPending();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setQueueBusy(false);
    }
  };

  const steerRemoteQueuedItem = async (item: UnifiedQueuedStripItem) => {
    if (queueBusy || item.source !== 'host' || !canSteerRemote) return;
    if (!online || !api.transportConnected) {
      onOffline();
      return;
    }
    setQueueBusy(true);
    setNotice('');
    try {
      await api.call(identity, 'steerQueued', { botId, requestId: item.requestId });
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setQueueBusy(false);
    }
  };

  useLayoutEffect(() => {
    if (supportsFieldSizing) return;
    const el = textareaRef.current;
    if (!el) return;
    if (!effectiveText) {
      el.style.height = '36px';
    } else {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
    }
  }, [effectiveText, supportsFieldSizing]);

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
      onStarted(input.requestId, input.text, attempt.draft, input.delivery);
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
          await drafts.reconcile(handle, { silent: true });
          return;
        }
        if (attempt.pendingId) {
          let pendingRecord = await api.pending(identity, 'pending_get', { id: attempt.pendingId });
          if (pendingRecord && (pendingRecord.kind !== 'primary' || pendingRecord.requestId !== input.requestId || pendingRecord.botId !== botId || pendingRecord.targetDeviceId !== identity.targetDeviceId || pendingRecord.text !== input.text)) return;
          if (pendingRecord?.state === 'sending' || pendingRecord?.state === 'unconfirmed') pendingRecord = await api.pending(identity, 'pending_reconcile', { id: attempt.pendingId });
          if (pendingRecord?.state === 'pending') pendingRecord = await api.pending(identity, 'pending_cancel', { id: attempt.pendingId });
          if (!alive) return;
          if (pendingRecord?.state === 'accepted' && pendingRecord.receipt) {
            onAccepted(pendingRecord.receipt as unknown as HostSubmission);
            if (attempt.cleared || await drafts.confirmCleared(handle) === 'cleared') drafts.finishSend(handle);
            return;
          }
          if (pendingRecord?.state === 'rejected') {
            const newer = drafts.conflict ?? api.snapshot?.state.drafts[handle.key];
            const attEqual = (a: DesktopDraftEntry, b: DesktopDraftEntry) => JSON.stringify(a.attachments ?? []) === JSON.stringify(b.attachments ?? []);
            const matches = (draft: DesktopDraftEntry) => Boolean(newer && newer.text === draft.text && JSON.stringify(newer.files) === JSON.stringify(draft.files) && attEqual(newer, draft));
            const changed = newer && (attempt.cleared ? Boolean(newer.text || newer.files.length || (newer.attachments?.length)) && !matches(attempt.draft) : !matches(attempt.draft) && !matches(attempt.baseDraft));
            if (drafts.conflict || changed) {
              setConfirmedConflict({ requestId: input.requestId, pendingId: pendingRecord.id, original: attempt.draft, handle });
              return;
            }
            if (attempt.cleared) {
              await api.queueWrite(state => {
                const current = state.drafts[handle.key];
                if (current && (current.text || current.files.length || (current.attachments?.length)) && (current.text !== attempt.draft.text || JSON.stringify(current.files) !== JSON.stringify(attempt.draft.files) || JSON.stringify(current.attachments ?? []) !== JSON.stringify(attempt.draft.attachments ?? []))) throw new Error(t('草稿已更新，不能覆盖。', 'Draft was updated and cannot be overwritten.'));
                return { ...state, drafts: { ...state.drafts, [handle.key]: attempt.draft } };
              });
              if (!alive) return;
            }
            drafts.finishSend(handle);
            if (attempt.cleared) {
              attempt.draft.files.forEach(file => drafts.addFile(file));
              if (attempt.draft.text || (attempt.draft.attachments?.length ?? 0) > 0) {
                drafts.mergeRecalled(
                  attempt.draft.text ? [attempt.draft.text] : [],
                  attempt.draft.attachments ?? [],
                  handle.key,
                );
              }
            }
            onNotSent(input.requestId);
            setNotice(t('请求未发送，草稿已恢复。', 'Request not sent; draft restored.'), 'info');
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
  }, [api, identity.generation, identity.targetDeviceId, botId, online, drafts.key, drafts.attempt?.id, drafts.attempt?.phase, drafts.attempt?.pendingId, drafts.conflict, confirmedConflict?.requestId]);

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
        if (!alive || record.state !== 'rejected' || !pending.draft) return;
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
          if (existing && (existing.text || existing.files.length || (existing.attachments?.length)) && (existing.text !== draft.text || JSON.stringify(existing.files) !== JSON.stringify(draft.files) || JSON.stringify(existing.attachments ?? []) !== JSON.stringify(draft.attachments ?? []))) throw new Error(t('草稿已更新，不能覆盖。', 'Draft was updated and cannot be overwritten.'));
          return { ...state, drafts: { ...state.drafts, [drafts.key!]: draft } };
        });
        if (!alive) return;
        drafts.editText(draft.text);
        if (!drafts.files.length) draft.files.forEach(file => drafts.addFile(file));
        (draft.attachments ?? []).forEach(att => drafts.addAttachment(att));
        onNotSent(pending.requestId);
        setNotice(t('请求未发送，草稿已恢复。', 'Request not sent; draft restored.'), 'info');
      } catch { /* preserve the original request when reconciliation fails */ }
      finally { reading = false; }
    };
    void recover();
    const timer = window.setInterval(recover, 2000);
    return () => { alive = false; window.clearInterval(timer); };
    // Current generation and the persisted request identify the only safe target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.requestId, pending?.pendingId, blocked, drafts.attempt?.id, drafts.key, online, identity.generation, identity.targetDeviceId, api, confirmedConflict?.requestId]);

  const keepNewerDraft = async () => {
    const conflict = confirmedConflict;
    const key = drafts.key;
    if (!conflict || !key || resolvingConflict) return;
    setResolvingConflict(true);
    try {
      const original = await api.pending(identity, 'pending_get', { id: conflict.pendingId });
      if (!original || original.kind !== 'primary' || original.requestId !== conflict.requestId || original.botId !== botId ||
        original.targetDeviceId !== identity.targetDeviceId || original.state !== 'rejected') {
        throw new Error(t('尚未确认请求已取消，无法结束旧尝试。', 'Cancellation is not confirmed; the original attempt remains locked.'));
      }
      if (!api.snapshot) throw new Error(t('持久草稿尚未加载。', 'Saved draft is not loaded.'));
      if (conflict.handle && drafts.attempt?.id === conflict.handle.attemptId) {
        if (drafts.conflict && !drafts.attempt.cleared) {
          const verified = await drafts.reconcile(conflict.handle);
          if (!verified.found || verified.recordState !== 'rejected') throw new Error(verified.note || t('无法核实旧请求', 'Unable to verify original request'));
          const adopted = drafts.adoptNewerDraftAndFinish(conflict.handle);
          if (!adopted.ok) throw new Error(adopted.error || t('无法采用新版草稿', 'Unable to adopt newer draft'));
        } else {
          drafts.finishSend(conflict.handle);
        }
      }
      const adopted = await drafts.adoptPersistedDraft(key);
      if (!adopted.ok) throw new Error(adopted.error || t('无法读取新版草稿', 'Unable to read newer draft'));
      onNotSent(conflict.requestId);
      setConfirmedConflict(undefined);
      setNotice(t('已保留新版草稿，旧请求已取消。', 'Kept the newer draft; the original request was cancelled.'), 'success');
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
    const draftTextBefore = drafts.text;
    slashBusyRef.current = true;
    setSlashBusy(command);
    // 进度提示由 Host 的 clearNotice（status）统一展示；此处不重复写错误卡片。
    setNotice('');
    try {
      const applied = await onRunCommand(command);
      // 仅服务端确认成功且当前草稿正是命令文本时清掉命令草稿；保留无关草稿、文件引用与图片附件。
      if (applied) {
        if (draftTextBefore.trim() === command && drafts.text.trim() === command) {
          drafts.editText('');
        }
        setNotice('');
        if (command === '/clear') setStopError('');
      }
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      slashBusyRef.current = false;
      setSlashBusy(undefined);
    }
  };

  const slash = useSlashAutocomplete({
    text: effectiveText,
    disabled: Boolean(editingTurn) || Boolean(drafts.attempt) || blocked || commandLocked || Boolean(fallbackDraft),
    onText: text => drafts.editText(text),
    onRun: command => void runCommand(command),
  });

  const waitingForReceipt = !confirmedConflict && drafts.attempt?.phase !== 'failed' &&
    (sendingNow || blocked || Boolean(drafts.attempt && drafts.attempt.phase !== 'not-sent'));
  const isRemoteSending =
    waitingForReceipt ||
    Boolean(editSubmitting) ||
    pending?.phase === 'sending' ||
    Boolean(drafts.attempt && ['locked', 'enqueued', 'cleared'].includes(drafts.attempt.phase));
  const hasRemoteDraft = Boolean(effectiveText.trim()) || effectiveAttachments.length > 0;
  const remoteComposerAction = resolveComposerActionKind({
    phase: activity.phase,
    online,
    isSending: isRemoteSending,
    isStopping: stopBusy,
    hasDraft: hasRemoteDraft,
    canStop,
  });
  const isStoppingPhase = remoteComposerAction === 'stopping';
  const isPreLlmPhase = remoteComposerAction === 'loading';
  const isLlmRunningPhase = remoteComposerAction === 'queue' || remoteComposerAction === 'stop';
  const canSteerRemote = canSteerBotActivity({
    activity,
    online: online && api.transportConnected,
    archived: false,
    isStopping: stopBusy || isStoppingPhase,
  });
  const showRemoteComposerStop =
    !editSubmitting &&
    shouldShowComposerStop({
      phase: activity.phase,
      online,
      archived: false,
      isStopping: isStoppingPhase,
      canStop,
    });

  const send = async (delivery: TurnDeliveryMode = 'followUp') => {
    if (editingTurn) {
      onSubmitEditTurn?.();
      return;
    }
    if (isPreLlmPhase || isStoppingPhase || waitingForReceipt || sending.current || commandLocked || blocked || fallbackDraft || imageUploading) return;
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
    const frozenTaskContext = taskContext;
    const prefix = frozenTaskContext?.prefix ?? '';
    const bodyText = prefix ? (trimmed ? `${prefix}${trimmed}` : prefix.trimEnd()) : trimmed;
    const text =
      bodyText +
      (drafts.files.length
        ? (bodyText ? '\n' : '') + drafts.files.map(file => `${t('[文件路径引用，未上传]', '[File path reference, not uploaded]')} ${file.path}`).join('\n')
        : '');
    const started = drafts.beginSend({
      kind: 'primary',
      targetDeviceId: identity.targetDeviceId,
      botId,
      requestId: uuid(),
      text,
      ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
      ...(delivery === 'steer' ? { delivery: 'steer' } : {}),
    });
    if (!started) return;
    sending.current = true;
    setSendingNow(true);
    if (started.attempt.input.kind !== 'primary') return;
    const requestId = started.attempt.input.requestId;
    onStarted(requestId, text, started.attempt.draft, started.attempt.input.delivery);
    onUserSend?.();
    setNotice('');
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (!onPersist(requestId)) {
        drafts.markNotSent(started.handle, t('无法保存请求', 'Cannot save request'));
        drafts.releaseIfNotSent(started.handle);
        onNotSent(requestId);
        setNotice(t('无法保存请求，未发送。', 'Cannot save request; not sent.'));
        return;
      }
      await drafts.waitQuiet(started.handle);
      if (!api.transportConnected) {
        drafts.markNotSent(started.handle, t('目标离线', 'Target offline'));
        drafts.releaseIfNotSent(started.handle);
        onNotSent(requestId);
        onOffline();
        return;
      }
      let enqueuedPending;
      try {
        enqueuedPending = await api.pending(identity, 'pending_enqueue', { input: started.attempt.input });
      } catch (error) {
        const message = errorText(error);
        if ((error as { outcome?: string })?.outcome === 'not-sent') { drafts.markNotSent(started.handle, message); drafts.releaseIfNotSent(started.handle); onNotSent(requestId); }
        else { drafts.markUnconfirmed(started.handle); onUnconfirmed(requestId); }
        setNotice((error as { outcome?: string })?.outcome === 'not-sent' ? message : '');
        return;
      }
      drafts.setPending(started.handle, enqueuedPending.id);
      onQueued(requestId, enqueuedPending.id);
      const cleared = await drafts.confirmCleared(started.handle);
      if (cleared !== 'cleared') {
        const message = t('草稿未清空，队列未发送；请对账并保留新版草稿。',
          'Draft not cleared; queued item not sent. Reconcile before continuing.');
        drafts.markFailed(started.handle, message);
        onUnconfirmed(requestId);
        setNotice(message);
        return;
      }
      if (!api.transportConnected) {
        drafts.markUnconfirmed(started.handle);
        onUnconfirmed(requestId);
        setNotice('');
        void refreshOutboxPending();
        return;
      }
      try {
        const sent = await api.pending(identity, 'pending_send', { id: enqueuedPending.id });
        if (sent.state === 'accepted') drafts.finishSend(started.handle);
        else drafts.markUnconfirmed(started.handle);
        if (sent.state === 'accepted') {
          mobileHaptic('tick');
          setNotice('');
          if (sent.receipt) onAccepted(sent.receipt as unknown as HostSubmission);
          if (trimmed) onTaskMessageSent?.(trimmed, frozenTaskContext);
        } else {
          onUnconfirmed(requestId);
          setNotice('');
        }
      } catch {
        drafts.markUnconfirmed(started.handle);
        onUnconfirmed(requestId);
        setNotice('');
      }
      void refreshOutboxPending();
    } finally {
      sending.current = false;
      setSendingNow(false);
    }
  };

  const mergeIdleLabel = t('合并到草稿', 'Merge into draft');
  const mergeBusyLabel = t('合并中…', 'Merging…');
  const keepNewerIdleLabel = t('保留新版草稿，结束旧尝试', 'Keep newer draft and end original attempt');
  const keepNewerBusyLabel = t('正在处理…', 'Resolving…');

  const dockActionsRef = useRef({
    drafts,
    remoteFetcher,
    keepNewerDraft,
    recallRemoteQueuedItem,
    recallAllRemoteQueued,
    steerRemoteQueuedItem,
  });
  dockActionsRef.current = {
    drafts,
    remoteFetcher,
    keepNewerDraft,
    recallRemoteQueuedItem,
    recallAllRemoteQueued,
    steerRemoteQueuedItem,
  };

  const hasDraftAttempt = Boolean(drafts.attempt);
  const isEditing = Boolean(editingTurn);
  const hasDraftKey = Boolean(drafts.key);
  const isTransferring = Boolean(transfer);

  const remoteDockItems = useMemo<ConditionDockItem[]>(() => {
    const items: ConditionDockItem[] = [];

    if (confirmedConflict) {
      items.push({
        id: 'remote-conflict',
        priority: 100,
        tone: 'danger',
        label: t('草稿冲突', 'Draft conflict'),
        collapsible: false,
        render: ctx => (
          <ActionSlip
            tone="danger"
            role="alert"
            compact
            ariaLabel={t('草稿冲突', 'Draft conflict')}
            title={ctx?.multiple ? undefined : t('草稿冲突', 'Draft conflict')}
            meta={t('原请求已确认未发送。请先查看或复制原文，再选择保留新版草稿。', 'The original request was not sent. Review or copy it before keeping the newer draft.')}
            className="remote-conflict-slip"
            footer={
              <Button
                size="sm"
                variant="secondary"
                disabled={resolvingConflict}
                onClick={() => void dockActionsRef.current.keepNewerDraft()}
              >
                <LabelStack
                  active={resolvingConflict ? keepNewerBusyLabel : keepNewerIdleLabel}
                  labels={[keepNewerIdleLabel, keepNewerBusyLabel]}
                />
              </Button>
            }
          >
            {confirmedConflict.original.attachments?.length ? (
              <SentAttachments
                attachments={confirmedConflict.original.attachments}
                fetcher={dockActionsRef.current.remoteFetcher}
              />
            ) : null}
            <textarea
              readOnly
              rows={4}
              className="remote-conflict-textarea"
              value={confirmedConflict.original.text}
              aria-label={t('原草稿，可选择复制', 'Original draft, selectable for copying')}
            />
            {confirmedConflict.original.files.map((file, index) => (
              <div key={`${file.path}:${index}`} className="remote-conflict-file pre-wrap">
                {file.name}: {file.path}
              </div>
            ))}
          </ActionSlip>
        ),
      });
    }

    if (fallbackDraft) {
      items.push({
        id: 'remote-fallback',
        priority: 70,
        tone: 'attention',
        label: t('离线草稿', 'Offline draft'),
        defaultExpanded: true,
        render: () => (
          <InlineBanner
            tone="attention"
            compact
            role="status"
            className="remote-fallback-banner"
            title={t('离线输入已保留', 'Offline draft retained')}
            detail={fallbackDraft}
            actions={
              <Button
                size="sm"
                variant="secondary"
                disabled={!hasDraftKey || hasDraftAttempt || isTransferring}
                onClick={() => {
                  const currentDrafts = dockActionsRef.current.drafts;
                  const text =
                    currentDrafts.text === fallbackDraft
                      ? currentDrafts.text
                      : [currentDrafts.text, fallbackDraft].filter(Boolean).join('\n');
                  setTransfer({ source: fallbackDraft, text });
                  currentDrafts.editText(text);
                }}
              >
                <LabelStack
                  active={isTransferring ? mergeBusyLabel : mergeIdleLabel}
                  labels={[mergeIdleLabel, mergeBusyLabel]}
                />
              </Button>
            }
          />
        ),
      });
    }

    if (!isEditing && queuedStripItems.length > 0) {
      items.push({
        id: 'remote-queue',
        priority: 30,
        tone: 'neutral',
        label: t('排队消息', 'Queue'),
        badge: queuedStripItems.length,
        defaultExpanded: true,
        render: () => (
          <PendingQueueStrip
            items={queuedStripItems}
            disabled={queueBusy || stopBusy}
            canSteer={canSteerRemote}
            onRecall={item => void dockActionsRef.current.recallRemoteQueuedItem(item, true)}
            onRecallAll={() => void dockActionsRef.current.recallAllRemoteQueued()}
            onDiscard={item => void dockActionsRef.current.recallRemoteQueuedItem(item, false)}
            onSteer={canSteerRemote ? (item => void dockActionsRef.current.steerRemoteQueuedItem(item)) : undefined}
            tr={t}
          />
        ),
      });
    }

    if (!isEditing && drafts.files.length > 0) {
      items.push({
        id: 'remote-files',
        priority: 20,
        tone: 'neutral',
        label: t('引用文件', 'Files'),
        badge: drafts.files.length,
        defaultExpanded: true,
        render: () => (
          <div className="grok-composer-files-row remote-composer-files-row">
            {drafts.files.map((file, index) => (
              <span key={`${file.path}:${index}`} className="grok-model-quick-chip active remote-file-chip">
                <span className="remote-file-chip-name">{file.name}</span>
                <button
                  type="button"
                  className="remote-file-chip-remove"
                  disabled={hasDraftAttempt || blocked}
                  onClick={() => dockActionsRef.current.drafts.removeFile(index)}
                  aria-label={t(`移除文件 ${file.name}`, `Remove file ${file.name}`)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ),
      });
    }

    return items;
  }, [
    confirmedConflict,
    resolvingConflict,
    keepNewerIdleLabel,
    keepNewerBusyLabel,
    fallbackDraft,
    hasDraftKey,
    hasDraftAttempt,
    isTransferring,
    mergeIdleLabel,
    mergeBusyLabel,
    isEditing,
    queuedStripItems,
    queueBusy,
    stopBusy,
    canSteerRemote,
    drafts.files,
    blocked,
    t,
  ]);

  useEffect(() => {
    if (!onDockItemsChange) return;
    onDockItemsChange(remoteDockItems);
  }, [onDockItemsChange, remoteDockItems]);

  useEffect(() => {
    if (!onDockItemsChange) return;
    return () => {
      onDockItemsChange([]);
    };
  }, [onDockItemsChange]);

  const standaloneDock = !onDockItemsChange && remoteDockItems.length > 0 ? (
    <ConditionDock items={remoteDockItems} className="remote-condition-dock" />
  ) : null;

  const voiceOnlyMessage = t('语音输入仅支持本机 Bot', 'Voice input is only available for local Bots');

  return (
    <>
      {standaloneDock
        ? floatingDockContainer
          ? createPortal(standaloneDock, floatingDockContainer)
          : (
              <div className="remote-composer-inline-dock">
                {standaloneDock}
              </div>
            )
        : null}

      <ComposerSlashPopover
        open={slash.open}
        query={effectiveText}
        listboxId={slash.listboxId}
        matches={slash.matches}
        activeIndex={slash.activeIndex}
        optionProps={slash.optionProps}
        anchorRef={composerRowRef}
        returnFocusRef={textareaRef}
      />

      {!hideInlineEditBanner ? (
        <SmoothExpand open={Boolean(editingTurn)}>
          {editingTurn || editBannerMounted ? (
            <ComposerEditBanner
              disabled={!editingTurn || Boolean(editSubmitting)}
              onCancel={() => onCancelEditTurn?.()}
              tr={t}
            />
          ) : null}
        </SmoothExpand>
      ) : null}

      <SmoothExpand open={effectiveAttachments.length > 0}>
        {effectiveAttachments.length > 0 ? (
          <div className="attachments" role="group" aria-label={t('附件', 'Attachments')}>
            {effectiveAttachments.map((att, index) => (
              <ImageAttachmentThumb
                key={att.id}
                attachment={att}
                fetcher={remoteFetcher}
                disabled={Boolean(drafts.attempt) || blocked || commandLocked || Boolean(editSubmitting)}
                onRemove={() => {
                  if (editingTurn) {
                    onChangeEditTurn?.({ attachments: editingTurn.attachments.filter((_, i) => i !== index) });
                  } else {
                    drafts.removeAttachment(index);
                  }
                }}
                t={t}
              />
            ))}
          </div>
        ) : null}
      </SmoothExpand>

      <div ref={composerRowRef} className="grok-composer-row">
        <ComposerPlusMenu
          open={composerMenuOpen}
          onOpenChange={next => {
            if (next !== composerMenuOpen) onToggleComposerMenu();
          }}
          inTauriUi={inTauriUi}
          imageDisabled={
            effectiveAttachments.length >= IMAGE_MAX_COUNT ||
            imageUploading ||
            Boolean(drafts.attempt) ||
            blocked ||
            commandLocked ||
            Boolean(editSubmitting)
          }
          onPickPhotos={() => pickRemoteImages('photos')}
          onPickCamera={() => pickRemoteImages('camera')}
          clearDisabled={Boolean(editingTurn)}
          onRequestClear={() => setClearConfirmOpen(true)}
        />

        <div className={`grok-composer-pill${editingTurn ? ' is-editing' : ''}`}>
          <textarea
            ref={textareaRef}
            rows={1}
            style={textareaStyle}
            className={effectiveText ? 'has-text' : 'is-empty'}
            value={effectiveText}
            disabled={Boolean(drafts.attempt) || blocked || commandLocked || Boolean(editSubmitting)}
            {...slash.textareaProps}
            onChange={event => {
              if (editingTurn) onChangeEditTurn?.({ text: event.target.value });
              else drafts.editText(event.target.value);
            }}
            aria-label={t('消息', 'Message')}
            enterKeyHint={coarsePointer ? 'enter' : 'send'}
            placeholder={
              editingTurn
                ? t('修改消息内容…', 'Edit message…')
                : botRole.length > 8
                  ? t('发消息…', 'Message…')
                  : t(`向 ${botRole} 发消息…`, `Message ${botRole}…`)
            }
            onPaste={e => {
              const files = extractPastedImageFiles(e.clipboardData);
              if (files.length === 0) return;
              if (!e.clipboardData?.getData('text/plain')?.trim()) {
                e.preventDefault();
              }
              pickRemoteImages('photos', files);
            }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Escape' && editingTurn && !editSubmitting) {
                e.preventDefault();
                onCancelEditTurn?.();
                return;
              }
              if (e.altKey && e.key === 'ArrowUp' && !editingTurn && queuedStripItems.length > 0 && !queueBusy) {
                e.preventDefault();
                void recallRemoteQueuedItem(queuedStripItems[queuedStripItems.length - 1], true);
                return;
              }
              if (slash.onKeyDown(e)) return;
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (editingTurn) onSubmitEditTurn?.();
                else if (!isPreLlmPhase && !isStoppingPhase) void send(canSteerRemote ? 'steer' : 'followUp');
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !isCoarsePointer()) {
                e.preventDefault();
                if (editingTurn) onSubmitEditTurn?.();
                else if (!isPreLlmPhase && !isStoppingPhase) void send('followUp');
              }
            }}
          />

          {!editingTurn && !hasRemoteDraft && !showRemoteComposerStop && !isStoppingPhase && (
            <button
              type="button"
              className="grok-composer-mic-inline is-unsupported"
              aria-disabled="true"
              aria-label={voiceOnlyMessage}
              title={coarsePointer ? undefined : voiceOnlyMessage}
              onClick={() =>
                notify({
                  id: unsupportedNoticeId,
                  tone: 'warning',
                  title: voiceOnlyMessage,
                  durationMs: 3000,
                })
              }
            >
              <Mic size={19} aria-hidden="true" />
            </button>
          )}

          <div className="grok-composer-actions">
            {editingTurn && onCancelEditTurn ? (
              <button
                type="button"
                className="grok-composer-edit-cancel-btn"
                aria-label={t('取消编辑 (Esc)', 'Cancel editing (Esc)')}
                title={t('取消编辑 (Esc)', 'Cancel editing (Esc)')}
                disabled={Boolean(editSubmitting)}
                onClick={onCancelEditTurn}
              >
                <X size={15} aria-hidden="true" />
              </button>
            ) : null}
            {isStoppingPhase ? (
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
                {!(isPreLlmPhase || waitingForReceipt || editSubmitting) && hasRemoteDraft ? (
                  <>
                    {!editingTurn && canSteerRemote ? (
                      <button
                        type="button"
                        className="grok-composer-steer-btn"
                        aria-label={t('打断并立即发送', 'Interrupt & send immediately')}
                        title={t('打断并立即发送 (Ctrl+Enter)', 'Interrupt & send immediately (Ctrl+Enter)')}
                        disabled={waitingForReceipt || imageUploading || Boolean(drafts.attempt) || blocked || Boolean(fallbackDraft) || commandLocked}
                        onClick={() => void send('steer')}
                      >
                        <Zap size={16} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="grok-composer-action-pill send"
                      disabled={waitingForReceipt || Boolean(editSubmitting) || (!effectiveText.trim() && effectiveAttachments.length === 0) || imageUploading || (!editingTurn && (Boolean(drafts.attempt) || blocked || Boolean(fallbackDraft))) || commandLocked}
                      onClick={() => void send('followUp')}
                      aria-label={editingTurn ? t('保存并重发', 'Save & resend') : isLlmRunningPhase ? t('排队发送', 'Queue message') : t('发送', 'Send')}
                    >
                      <SendButtonIcon busy={false} />
                    </button>
                  </>
                ) : null}
                {showRemoteComposerStop ? (
                  <button
                    type="button"
                    className="grok-composer-action-pill stop"
                    aria-label={t('停止此 Bot', 'Stop this bot')}
                    onClick={() => void runAbort()}
                  >
                    <Square size={15} />
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
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
          void runCommand('/clear');
        }}
      />
    </>
  );
}
