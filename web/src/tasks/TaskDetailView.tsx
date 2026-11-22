import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, CheckCircle2, ChevronRight, HelpCircle, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { Button, InlineBanner } from '../components/ui';
import { GrokBotAvatar, type GrokAvatarPreset } from '../GrokBotAvatar';
import { mobileHaptic } from '../native/tauri-host';
import { useText } from '../ui';
import {
  getStepStatusInfo,
  getTaskStatusInfo,
  isTaskRevisionConflictError,
  stepCounts,
  type GlobalTask,
  type TaskBotOption,
  type TaskBotRef,
  type TaskStep,
  type TaskStepStatus,
} from './types';
import type { GlobalTasksController } from './useGlobalTasks';

export interface TaskDetailViewProps {
  task: GlobalTask;
  controller: GlobalTasksController;
  bots: TaskBotOption[];
  initialEditMode?: boolean;
  onBack: () => void;
  onJumpToChat: (target: { deviceId: string; botId: string; taskId: string; stepId?: string | null }) => void;
}

interface DraftStepItem {
  id?: string;
  parentStepId: string | null;
  text: string;
  status: TaskStepStatus;
  botValue: string;
  dependsOnStepIds?: string[];
  preserved?: boolean;
  relationNote?: string;
  resultSummary?: string;
}

interface EditDraftState {
  editBaseRevision: number;
  title: string;
  requirement: string;
  steps: DraftStepItem[];
  newStepText: string;
  newStepBotValue: string;
}

const isCoarsePointerQuery = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(isCoarsePointerQuery);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(pointer: coarse)');
    setCoarse(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    }
  }, []);
  return coarse;
}

function encodeBotValue(deviceId: string | null | undefined, botId: string | null | undefined): string {
  if (!botId) return '';
  return JSON.stringify([deviceId ?? '', botId]);
}

function decodeBotValue(value: string): { deviceId: string | null; botId: string | null } {
  if (!value) return { deviceId: null, botId: null };
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && typeof parsed[1] === 'string' && parsed[1]) {
      return {
        deviceId: typeof parsed[0] === 'string' && parsed[0] ? parsed[0] : null,
        botId: parsed[1],
      };
    }
  } catch {
    // Ignore malformed value
  }
  return { deviceId: null, botId: null };
}

function asGrokAvatar(avatar: unknown): GrokAvatarPreset | undefined {
  if (avatar && typeof avatar === 'object' && 'shape' in avatar && 'color' in avatar) {
    return avatar as GrokAvatarPreset;
  }
  return undefined;
}

function findBotOption(
  bots: TaskBotOption[],
  deviceId: string | null | undefined,
  botId: string | null | undefined,
): TaskBotOption | undefined {
  if (!botId) return undefined;
  if (deviceId) {
    const exact = bots.find(b => b.deviceId === deviceId && b.botId === botId);
    if (exact) return exact;
  }
  return bots.find(b => b.botId === botId);
}

function flattenStepsWithDepth(steps: TaskStep[]): Array<{ step: TaskStep; depth: number }> {
  const byId = new Set(steps.map(s => s.id));
  const childrenMap = new Map<string | null, TaskStep[]>();
  for (const step of steps) {
    const parentKey =
      step.parentStepId && byId.has(step.parentStepId) && step.parentStepId !== step.id
        ? step.parentStepId
        : null;
    const list = childrenMap.get(parentKey) ?? [];
    list.push(step);
    childrenMap.set(parentKey, list);
  }
  const result: Array<{ step: TaskStep; depth: number }> = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    const list = childrenMap.get(parentId);
    if (!list) return;
    for (const step of list) {
      if (visited.has(step.id)) continue;
      visited.add(step.id);
      result.push({ step, depth });
      walk(step.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const step of steps) {
    if (!visited.has(step.id)) {
      visited.add(step.id);
      result.push({ step, depth: 0 });
    }
  }
  return result;
}

function formatLogTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '';
  const date = new Date(epochMs);
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return `${hh}:${mm}`;
  }
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const da = String(date.getDate()).padStart(2, '0');
  return `${mo}-${da} ${hh}:${mm}`;
}

function createEditDraft(task: GlobalTask): EditDraftState {
  return {
    editBaseRevision: task.revision,
    title: task.title,
    requirement: task.requirement,
    steps: task.steps.map(step => ({
      id: step.id,
      parentStepId: step.parentStepId ?? null,
      text: step.text,
      status: step.status,
      botValue: encodeBotValue(step.deviceId, step.botId),
      dependsOnStepIds: step.dependsOnStepIds,
      preserved: step.preserved,
      relationNote: step.relationNote,
      resultSummary: step.resultSummary,
    })),
    newStepText: '',
    newStepBotValue: '',
  };
}

function renderTaskStatusBadge(task: GlobalTask, t: (zh: string, en: string) => string) {
  const info = getTaskStatusInfo(task, t);
  return (
    <span className={`bs-badge ${info.cls}`}>
      {info.spinning ? <Loader2 size={12} className="spin" aria-hidden="true" /> : null}
      {info.label}
    </span>
  );
}

export function TaskDetailView({
  task,
  controller,
  bots,
  initialEditMode = false,
  onBack,
  onJumpToChat,
}: TaskDetailViewProps) {
  const t = useText();
  const titleInputId = useId();
  const titleErrorId = useId();
  const reqInputId = useId();
  const stepErrorBaseId = useId();
  const logsBoxId = useId();
  const isCoarsePointer = useIsCoarsePointer();

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const stepInputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const [editMode, setEditMode] = useState(initialEditMode);
  const [editDraft, setEditDraft] = useState<EditDraftState>(() => createEditDraft(task));
  const [logsOpen, setLogsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadingEdit, setReloadingEdit] = useState(false);
  const [editConflict, setEditConflict] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [adoptionBusy, setAdoptionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [stepErrors, setStepErrors] = useState<Record<number, string>>({});

  useEffect(() => {
    setEditMode(initialEditMode);
    setEditDraft(createEditDraft(task));
    setEditConflict(false);
    setDeleteArmed(false);
    setActionError(null);
    setTitleError(null);
    setStepErrors({});
    // Reset edit draft only when switching task or initialEditMode prop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, initialEditMode]);

  useEffect(() => {
    if (!deleteArmed) return;
    const timer = window.setTimeout(() => {
      setDeleteArmed(false);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [deleteArmed]);

  const counts = useMemo(() => stepCounts(task), [task]);
  const flatSteps = useMemo(() => flattenStepsWithDepth(task.steps), [task.steps]);
  const hasRevisionConflict = editMode && (editConflict || task.revision !== editDraft.editBaseRevision);

  const topBots = useMemo(() => {
    const seen = new Set<string>();
    const list: TaskBotRef[] = [];
    const pushRef = (deviceId: string | null | undefined, botId: string | null | undefined, botName?: string | null) => {
      if (!botId) return;
      const resolved = findBotOption(bots, deviceId, botId);
      const devId = deviceId || resolved?.deviceId || '';
      const key = `${devId}:${botId}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({
        deviceId: devId,
        botId,
        botName: resolved?.name || botName || undefined,
      });
    };
    for (const ref of task.botRefs) {
      pushRef(ref.deviceId, ref.botId, ref.botName);
    }
    if (task.pendingPrompt) {
      pushRef(task.pendingPrompt.deviceId, task.pendingPrompt.botId, task.pendingPrompt.botName);
    }
    if (list.length === 0 && task.coordinatorBotId) {
      pushRef(task.coordinatorDeviceId, task.coordinatorBotId);
    }
    return list;
  }, [task.botRefs, task.pendingPrompt, task.coordinatorDeviceId, task.coordinatorBotId, bots]);

  const openEditMode = () => {
    setEditDraft(createEditDraft(task));
    setEditConflict(false);
    setDeleteArmed(false);
    setActionError(null);
    setTitleError(null);
    setStepErrors({});
    setEditMode(true);
  };

  const exitEditMode = () => {
    if (saving || deleting || reloadingEdit) return;
    setEditMode(false);
    setEditConflict(false);
    setDeleteArmed(false);
    setActionError(null);
    setTitleError(null);
    setStepErrors({});
  };

  const handleReloadLatestForEdit = async () => {
    if (reloadingEdit || saving || deleting) return;
    setReloadingEdit(true);
    setActionError(null);
    try {
      const latest = (await controller.getTask(task.id)) ?? task;
      setEditDraft(createEditDraft(latest));
      setEditConflict(false);
      setTitleError(null);
      setStepErrors({});
    } catch (err) {
      setActionError(
        err instanceof Error && err.message ? err.message : String(err || t('重新载入当前版本失败', 'Failed to reload latest version')),
      );
    } finally {
      setReloadingEdit(false);
    }
  };

  const handleAddDraftStep = () => {
    const text = editDraft.newStepText.trim();
    if (!text) return;
    const { botId } = decodeBotValue(editDraft.newStepBotValue);
    setEditDraft(prev => ({
      ...prev,
      steps: [
        ...prev.steps,
        {
          parentStepId: null,
          text,
          status: botId ? 'todo' : 'unassigned',
          botValue: prev.newStepBotValue,
        },
      ],
      newStepText: '',
      newStepBotValue: '',
    }));
  };

  const handleNewStepKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      handleAddDraftStep();
    }
  };

  const handleToggleStepCancel = (index: number) => {
    setEditDraft(prev => {
      const nextSteps = prev.steps.slice();
      const target = nextSteps[index];
      if (!target || target.status === 'done') return prev;
      if (target.status === 'cancelled') {
        const { botId } = decodeBotValue(target.botValue);
        nextSteps[index] = { ...target, status: botId ? 'todo' : 'unassigned' };
      } else {
        nextSteps[index] = { ...target, status: 'cancelled' };
      }
      return { ...prev, steps: nextSteps };
    });
  };

  const handleSaveEdit = async () => {
    if (saving || deleting || reloadingEdit || hasRevisionConflict) return;

    // Inline validation instead of silent title revert or silent step drop.
    const trimmedTitle = editDraft.title.trim();
    const nextTitleError = trimmedTitle ? null : t('请输入任务标题', 'Task title cannot be empty');
    const nextStepErrors: Record<number, string> = {};
    let firstInvalidStepIdx = -1;
    editDraft.steps.forEach((step, idx) => {
      if (!step.text.trim()) {
        nextStepErrors[idx] = t('请输入子任务名称，或恢复原内容', 'Subtask name cannot be empty');
        if (firstInvalidStepIdx === -1) firstInvalidStepIdx = idx;
      }
    });

    if (nextTitleError || firstInvalidStepIdx !== -1) {
      setTitleError(nextTitleError);
      setStepErrors(nextStepErrors);
      if (nextTitleError) {
        titleInputRef.current?.focus();
      } else if (firstInvalidStepIdx !== -1) {
        stepInputRefs.current[firstInvalidStepIdx]?.focus();
      }
      return;
    }

    setTitleError(null);
    setStepErrors({});
    setSaving(true);
    setActionError(null);
    try {
      const pendingNewText = editDraft.newStepText.trim();
      const draftSteps = pendingNewText
        ? [
            ...editDraft.steps,
            {
              parentStepId: null,
              text: pendingNewText,
              status: decodeBotValue(editDraft.newStepBotValue).botId ? ('todo' as const) : ('unassigned' as const),
              botValue: editDraft.newStepBotValue,
            },
          ]
        : editDraft.steps;

      const stepsPayload = draftSteps.map(step => {
        const text = step.text.trim();
        const { deviceId, botId } = decodeBotValue(step.botValue);
        const resolvedBot = findBotOption(bots, deviceId, botId);
        const effectiveDeviceId = deviceId || resolvedBot?.deviceId || null;
        let status = step.status;
        if (status !== 'done' && status !== 'cancelled') {
          if (!botId) {
            status = 'unassigned';
          } else if (status === 'unassigned') {
            status = 'todo';
          }
        }
        return {
          ...(step.id ? { id: step.id } : {}),
          parentStepId: step.parentStepId,
          text,
          status,
          deviceId: effectiveDeviceId,
          botId,
          ...(step.dependsOnStepIds ? { dependsOnStepIds: step.dependsOnStepIds } : {}),
          ...(step.preserved !== undefined ? { preserved: step.preserved } : {}),
          ...(step.relationNote !== undefined ? { relationNote: step.relationNote } : {}),
          ...(step.resultSummary !== undefined ? { resultSummary: step.resultSummary } : {}),
        };
      });

      await controller.updateTask({
        taskId: task.id,
        expectedRevision: editDraft.editBaseRevision,
        title: trimmedTitle,
        requirement: editDraft.requirement.trim(),
        steps: stepsPayload,
      });
      mobileHaptic('confirm');
      setEditConflict(false);
      setEditMode(false);
    } catch (err) {
      if (isTaskRevisionConflictError(err)) {
        setEditConflict(true);
        setActionError(null);
        void controller.getTask(task.id).catch(() => {});
      } else {
        setActionError(
          err instanceof Error && err.message ? err.message : String(err || t('保存任务修改失败', 'Failed to save task changes')),
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const handleEditCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleSaveEdit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      exitEditMode();
    }
  };

  const handleDeleteTask = async () => {
    if (deleting || saving) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setDeleting(true);
    setActionError(null);
    try {
      await controller.deleteTask(task.id);
      onBack();
    } catch (err) {
      setActionError(err instanceof Error && err.message ? err.message : String(err || t('删除任务失败', 'Failed to delete task')));
      setDeleting(false);
      setDeleteArmed(false);
    }
  };

  const handleAdoptionScope = async (scope: 'keep' | 'redo') => {
    if (adoptionBusy) return;
    setAdoptionBusy(true);
    setActionError(null);
    try {
      await controller.resolveAdoptionScope(task.id, scope, task.revision);
    } catch (err) {
      if (isTaskRevisionConflictError(err)) {
        void controller.getTask(task.id).catch(() => {});
        setActionError(t('任务状态刚刚已有更新，已同步最新版本，请重新核对后再确认。', 'Task status was just updated and synced. Please review before confirming.'));
      } else {
        setActionError(
          err instanceof Error && err.message ? err.message : String(err || t('确认变更范围失败', 'Failed to confirm change scope')),
        );
      }
    } finally {
      setAdoptionBusy(false);
    }
  };

  const handleDismissAdoption = async () => {
    if (adoptionBusy) return;
    setAdoptionBusy(true);
    setActionError(null);
    try {
      await controller.dismissAdoption(task.id);
    } catch (err) {
      setActionError(err instanceof Error && err.message ? err.message : String(err || t('收起回执失败', 'Failed to dismiss receipt')));
    } finally {
      setAdoptionBusy(false);
    }
  };

  const renderAdoptionStrip = () => {
    const ad = task.adoption;
    if (!ad) return null;
    if (ad.phase === 'recorded' || ad.phase === 'adjusting') {
      return (
        <div className="adoption-short-strip" role="status">
          <span className="adoption-short-main">
            <Loader2 size={15} className="spin" aria-hidden="true" />
            <span>{t('修改已保存，负责人正在调整…', 'Changes saved; owner is adjusting…')}</span>
          </span>
        </div>
      );
    }
    if (ad.phase === 'needs_scope') {
      return (
        <div className="adoption-short-strip is-warn" role="region" aria-label={t('确认变更范围', 'Confirm change scope')}>
          <span className="adoption-short-main">
            <span>{t('此项变更是否保留已完成产出？', 'Keep completed outputs for this change?')}</span>
          </span>
          <div className="adoption-short-actions">
            <button
              type="button"
              className="mini-pill active"
              disabled={adoptionBusy}
              onClick={() => void handleAdoptionScope('keep')}
            >
              {t('保留已有结果', 'Keep existing results')}
            </button>
            <button
              type="button"
              className="mini-pill"
              disabled={adoptionBusy}
              onClick={() => void handleAdoptionScope('redo')}
            >
              {t('连同前序重做', 'Redo previous steps')}
            </button>
          </div>
        </div>
      );
    }
    const isOk = ad.phase === 'adopted';
    const text = ad.shortReceipt || (isOk ? t('已采用变更', 'Changes adopted') : t('已记录变更', 'Changes recorded'));
    return (
      <div className={`adoption-short-strip${isOk ? ' is-ok' : ''}`} role="status">
        <span className="adoption-short-main">
          {isOk ? (
            <CheckCircle2 size={15} aria-hidden="true" />
          ) : (
            <HelpCircle size={15} aria-hidden="true" />
          )}
          <span>{text}</span>
        </span>
        <div className="adoption-short-actions">
          <button
            type="button"
            className="receipt-log-link"
            onClick={() => setLogsOpen(true)}
          >
            {t('查看记录', 'View log')}
          </button>
          <button
            type="button"
            className="notice-dismiss"
            disabled={adoptionBusy}
            onClick={() => void handleDismissAdoption()}
            aria-label={t('收起回执', 'Dismiss receipt')}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  };

  const promptBotName = useMemo(() => {
    if (!task.pendingPrompt) return '';
    const found = findBotOption(bots, task.pendingPrompt.deviceId, task.pendingPrompt.botId);
    return found?.name || task.pendingPrompt.botName || t('未知 Bot', 'Unknown Bot');
  }, [task.pendingPrompt, bots, t]);

  const deleteLiveAnnouncement = deleting
    ? t('正在删除任务…', 'Deleting task…')
    : deleteArmed
      ? t('已进入删除确认状态，4 秒内再次点击将永久删除此任务', 'Delete armed. Activate again within 4 seconds to permanently delete this task.')
      : '';

  return (
    <div className="tasks-scroll">
      <div className="tasks-container page-enter">
        <header className="detail-topbar">
          <button type="button" className="back-btn" onClick={onBack}>
            <ArrowLeft size={19} aria-hidden="true" />
            <span>{t('任务', 'Tasks')}</span>
          </button>
          {!editMode ? (
            <button type="button" className="tb-secondary-btn" onClick={openEditMode}>
              <Pencil size={15} aria-hidden="true" />
              <span>{t('编辑', 'Edit')}</span>
            </button>
          ) : null}
        </header>

        <div className="detail-stack">
          {renderAdoptionStrip()}

          {actionError ? (
            <InlineBanner
              tone="danger"
              compact
              role="alert"
              className="tasks-error-banner"
              title={actionError}
            />
          ) : null}

          {hasRevisionConflict ? (
            <InlineBanner
              tone="attention"
              role="alert"
              className="detail-conflict-banner"
              title={
                <span className="tabular-nums">
                  {editConflict
                    ? t(`保存冲突（编辑基准 v${editDraft.editBaseRevision}，最新 v${task.revision}）：你的修改草稿已保留在下方`, `Save conflict (base v${editDraft.editBaseRevision}, latest v${task.revision}): your draft is preserved below`)
                    : t(`后台已有新进展（编辑基准 v${editDraft.editBaseRevision}，最新 v${task.revision}）`, `Updated in background (base v${editDraft.editBaseRevision}, latest v${task.revision})`)}
                </span>
              }
              detail={
                <div className="detail-conflict-details">
                  <p className="detail-conflict-summary tabular-nums">
                    {t('当前最新状态：', 'Latest status: ')}
                    {task.title} · {t(`已完成 ${counts.done}/${counts.total}`, `Done ${counts.done}/${counts.total}`)}
                    {task.logs.length > 0 ? ` · ${task.logs[task.logs.length - 1].text}` : ''}
                  </p>
                  <p className="detail-conflict-note">
                    {t('为防止覆盖 Bot 最新进展，当前已禁用保存；请核对后重新载入当前版本再继续编辑。', 'Saving is disabled to avoid overwriting the latest Bot progress. Reload the latest version to continue editing.')}
                  </p>
                </div>
              }
              actions={
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={saving || deleting || reloadingEdit}
                    onClick={() => void handleReloadLatestForEdit()}
                  >
                    {reloadingEdit ? t('载入中…', 'Reloading…') : t('重新载入当前版本', 'Reload latest version')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={saving || deleting || reloadingEdit}
                    onClick={exitEditMode}
                  >
                    {t('退出编辑核对详情', 'Exit edit to review')}
                  </Button>
                </>
              }
            />
          ) : null}

          {editMode ? (
            <section
              className="detail-edit-card"
              aria-label={t('编辑任务要求与子任务', 'Edit task requirements and subtasks')}
              onKeyDown={handleEditCardKeyDown}
            >
              <div className="edit-field-block">
                <label className="edit-field-label" htmlFor={titleInputId}>
                  {t('任务标题', 'Task title')}
                </label>
                <input
                  ref={titleInputRef}
                  id={titleInputId}
                  className="req-edit-title"
                  type="text"
                  value={editDraft.title}
                  aria-invalid={Boolean(titleError) || undefined}
                  aria-describedby={titleError ? titleErrorId : undefined}
                  onChange={e => {
                    if (titleError) setTitleError(null);
                    setEditDraft(prev => ({ ...prev, title: e.target.value }));
                  }}
                  disabled={saving || deleting}
                />
                {titleError ? (
                  <p id={titleErrorId} className="field-error-text" role="alert">
                    {titleError}
                  </p>
                ) : null}
              </div>

              <div className="edit-field-block">
                <label className="edit-field-label" htmlFor={reqInputId}>
                  {t('整体要求', 'Requirements')}
                </label>
                <textarea
                  id={reqInputId}
                  className="req-edit-textarea"
                  value={editDraft.requirement}
                  onChange={e => setEditDraft(prev => ({ ...prev, requirement: e.target.value }))}
                  disabled={saving || deleting}
                />
              </div>

              <fieldset className="edit-steps-fieldset edit-steps-group">
                <legend className="edit-steps-legend edit-field-label">
                  {t('分工与子任务', 'Plan & subtasks')}
                </legend>
                {editDraft.steps.map((step, idx) => {
                  const stepNum = idx + 1;
                  const isDone = step.status === 'done';
                  const isCancelled = step.status === 'cancelled';
                  const stepErr = stepErrors[idx];
                  const stepErrId = `${stepErrorBaseId}-${idx}`;
                  const decodedCurrent = decodeBotValue(step.botValue);
                  const currentMissing =
                    Boolean(decodedCurrent.botId) &&
                    !bots.some(
                      b => encodeBotValue(b.deviceId, b.botId) === step.botValue,
                    );
                  const origStep = step.id ? task.steps.find(s => s.id === step.id) : undefined;
                  return (
                    <div key={step.id ?? `draft-${idx}`} className="edit-step-entry">
                      <div className="edit-step-row">
                        <input
                          ref={el => { stepInputRefs.current[idx] = el; }}
                          className={`edit-step-input${isCancelled ? ' is-cancelled' : ''}`}
                          type="text"
                          value={step.text}
                          aria-label={t(`第 ${stepNum} 项子任务名称`, `Subtask ${stepNum} name`)}
                          aria-invalid={Boolean(stepErr) || undefined}
                          aria-describedby={stepErr ? stepErrId : undefined}
                          disabled={saving || deleting}
                          onChange={e => {
                            const val = e.target.value;
                            if (stepErrors[idx]) {
                              setStepErrors(prev => {
                                const next = { ...prev };
                                delete next[idx];
                                return next;
                              });
                            }
                            setEditDraft(prev => {
                              const next = prev.steps.slice();
                              next[idx] = { ...next[idx], text: val };
                              return { ...prev, steps: next };
                            });
                          }}
                        />
                        <select
                          className="edit-step-select"
                          aria-label={t(`第 ${stepNum} 项子任务负责 Bot`, `Subtask ${stepNum} assigned Bot`)}
                          value={step.botValue}
                          disabled={isDone || isCancelled || saving || deleting}
                          onChange={e => {
                            const val = e.target.value;
                            setEditDraft(prev => {
                              const next = prev.steps.slice();
                              next[idx] = { ...next[idx], botValue: val };
                              return { ...prev, steps: next };
                            });
                          }}
                        >
                          <option value="">{t('等待安排（待接手）', 'Unassigned (pending)')}</option>
                          {currentMissing ? (
                            <option value={step.botValue}>
                              {origStep?.botName || t('未知 Bot', 'Unknown Bot')}
                            </option>
                          ) : null}
                          {bots.map(bot => (
                            <option
                              key={`${bot.deviceId}:${bot.botId}`}
                              value={encodeBotValue(bot.deviceId, bot.botId)}
                            >
                              {bot.name}
                            </option>
                          ))}
                        </select>
                        {!isDone ? (
                          <button
                            type="button"
                            className="mini-pill"
                            aria-label={
                              isCancelled
                                ? t(`恢复第 ${stepNum} 项子任务`, `Restore subtask ${stepNum}`)
                                : t(`取消第 ${stepNum} 项子任务`, `Cancel subtask ${stepNum}`)
                            }
                            disabled={saving || deleting}
                            onClick={() => handleToggleStepCancel(idx)}
                          >
                            {isCancelled ? t('恢复', 'Restore') : t('取消此项', 'Cancel')}
                          </button>
                        ) : (
                          <span className="step-status-pill is-done">{t('已完成', 'Done')}</span>
                        )}
                      </div>
                      {stepErr ? (
                        <p id={stepErrId} className="field-error-text" role="alert">
                          {stepErr}
                        </p>
                      ) : null}
                    </div>
                  );
                })}

                <div className="edit-step-row">
                  <input
                    className="edit-step-input"
                    type="text"
                    value={editDraft.newStepText}
                    placeholder={t('新增子任务名称…', 'Add a subtask…')}
                    aria-label={t('新增子任务名称', 'New subtask name')}
                    disabled={saving || deleting}
                    onChange={e => setEditDraft(prev => ({ ...prev, newStepText: e.target.value }))}
                    onKeyDown={handleNewStepKeyDown}
                  />
                  <select
                    className="edit-step-select"
                    aria-label={t('新子任务负责 Bot', 'New subtask Bot')}
                    value={editDraft.newStepBotValue}
                    disabled={saving || deleting}
                    onChange={e => setEditDraft(prev => ({ ...prev, newStepBotValue: e.target.value }))}
                  >
                    <option value="">{t('等待安排', 'Unassigned')}</option>
                    {bots.map(bot => (
                      <option
                        key={`${bot.deviceId}:${bot.botId}`}
                        value={encodeBotValue(bot.deviceId, bot.botId)}
                      >
                        {bot.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="mini-pill"
                    disabled={!editDraft.newStepText.trim() || saving || deleting}
                    onClick={handleAddDraftStep}
                  >
                    {t('+ 添加', '+ Add')}
                  </button>
                </div>
              </fieldset>

              <div className="req-edit-actions">
                <span className="sr-only" role="status" aria-live="polite">
                  {deleteLiveAnnouncement}
                </span>
                <button
                  type="button"
                  className={`tb-danger-link${deleteArmed ? ' is-armed' : ''}`}
                  disabled={saving || deleting}
                  onClick={() => void handleDeleteTask()}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  <span>
                    {deleting
                      ? t('删除中…', 'Deleting…')
                      : deleteArmed
                        ? t('再次点击确认删除', 'Tap again to confirm delete')
                        : t('删除任务', 'Delete task')}
                  </span>
                </button>
                <div className="req-edit-actions-right">
                  <button
                    type="button"
                    className="tb-secondary-btn"
                    disabled={saving || deleting || reloadingEdit}
                    onClick={exitEditMode}
                  >
                    {t('取消', 'Cancel')}
                  </button>
                  <button
                    type="button"
                    className="tb-primary-btn"
                    disabled={saving || deleting || reloadingEdit || hasRevisionConflict}
                    onClick={() => void handleSaveEdit()}
                  >
                    {saving ? t('保存中…', 'Saving…') : t('保存', 'Save')}
                  </button>
                </div>
              </div>
            </section>
          ) : (
            <>
              <section className="req-card" aria-label={t('任务整体说明', 'Task overview')}>
                <div className="req-meta-row">
                  <div className="req-meta-left">
                    {renderTaskStatusBadge(task, t)}
                    {task.origin?.label ? <span>{task.origin.label}</span> : null}
                  </div>
                  {topBots.length > 0 ? (
                    <div className="top-bots-row">
                      {topBots.map(ref => {
                        const bot = findBotOption(bots, ref.deviceId, ref.botId);
                        const displayName = bot?.name || ref.botName || t('未知 Bot', 'Unknown Bot');
                        const isPromptOwner =
                          task.pendingPrompt &&
                          task.pendingPrompt.deviceId === ref.deviceId &&
                          task.pendingPrompt.botId === ref.botId;
                        const suffix = isPromptOwner
                          ? task.pendingPrompt!.kind === 'plan'
                            ? t(' · 待确认', ' · Confirm')
                            : t(' · 待回应', ' · Reply')
                          : '';
                        const openChatLabel = t(`进入与 ${displayName} 的任务对话`, `Open task chat with ${displayName}`);
                        return (
                          <button
                            key={`${ref.deviceId}:${ref.botId}`}
                            type="button"
                            className="bot-chip-btn"
                            aria-label={openChatLabel}
                            title={isCoarsePointer ? undefined : openChatLabel}
                            onClick={() =>
                              onJumpToChat({
                                deviceId: ref.deviceId || bot?.deviceId || '',
                                botId: ref.botId,
                                taskId: task.id,
                                stepId: null,
                              })
                            }
                          >
                            <GrokBotAvatar
                              preset={asGrokAvatar(bot?.avatar)}
                              botKey={`${ref.deviceId}:${ref.botId}`}
                              roleName={displayName}
                              isPrimary={bot?.isPrimary}
                              offline={bot ? bot.online === false : false}
                              size={18}
                            />
                            <span>
                              {displayName}
                              {suffix}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="bot-unassigned">{t('等待安排', 'Unassigned')}</span>
                  )}
                </div>

                <h2 className="req-title">{task.title}</h2>
                {task.requirement ? <p className="req-body">{task.requirement}</p> : null}

                {task.pendingPrompt ? (
                  <p className="detail-chat-hint">
                    {task.pendingPrompt.kind === 'plan'
                      ? t(`待确认安排：点击「${promptBotName}」进入对话确认后开始执行`, `Plan awaiting confirmation: open chat with "${promptBotName}" to confirm and start`)
                      : t(`待你回应：点击「${promptBotName}」进入对话处理提问`, `Awaiting reply: open chat with "${promptBotName}" to answer`)}
                  </p>
                ) : null}
              </section>

              <section className="steps-card" aria-label={t('分工与子任务', 'Plan & subtasks')}>
                <div className="steps-head">
                  <span className="steps-head-title">{t('分工与子任务', 'Plan & subtasks')}</span>
                  <span className="steps-head-count tabular tabular-nums">
                    {t(`已完成 ${counts.done} / ${counts.total}`, `Done ${counts.done} / ${counts.total}`)}
                  </span>
                </div>

                {flatSteps.length === 0 ? (
                  <div className="tasks-empty is-compact">
                    {task.status === 'triaging'
                      ? t('正在拆分与安排子任务…', 'Breaking down and assigning subtasks…')
                      : t('暂无拆分子任务，点右上角「编辑」可手动补充或进入对话协调。', 'No subtasks yet. Tap Edit above to add steps or coordinate in chat.')}
                  </div>
                ) : (
                  <div className="steps-list">
                    {flatSteps.map(({ step, depth }) => {
                      const stInfo = getStepStatusInfo(task, step, t);
                      const noteParts: string[] = [];
                      if (step.preserved && step.status === 'done') noteParts.push(t('原结果已保留', 'Previous result kept'));
                      if (step.relationNote && step.status !== 'cancelled') noteParts.push(step.relationNote);

                      const stepBot = findBotOption(bots, step.deviceId, step.botId);
                      const stepBotName = stepBot?.name || step.botName || (step.botId ? t('未知 Bot', 'Unknown Bot') : '');
                      const targetDeviceId = step.deviceId || stepBot?.deviceId || '';
                      const openStepChatLabel = t(`进入 ${stepBotName} 对话查看或处理此子项`, `Open chat with ${stepBotName} for this step`);

                      return (
                        <div key={step.id} className={`step-item${depth > 0 ? ' is-nested' : ''}`}>
                          <div className="step-row-view">
                            <div className="step-title-col">
                              <div className="step-name-line">
                                <span className={`step-aux-dot ${stInfo.cls}`} aria-hidden="true" />
                                <span
                                  className={`step-text${step.status === 'cancelled' ? ' is-cancelled' : ''}`}
                                >
                                  {step.text}
                                </span>
                              </div>
                              {noteParts.length > 0 ? (
                                <div className="step-short-note">
                                  <span>{noteParts.join(' · ')}</span>
                                </div>
                              ) : null}
                            </div>

                            <div className="step-meta-col">
                              <span className={`step-status-pill ${stInfo.cls}`}>{stInfo.label}</span>
                              {step.botId ? (
                                <button
                                  type="button"
                                  className="bot-chip-btn"
                                  aria-label={openStepChatLabel}
                                  title={isCoarsePointer ? undefined : openStepChatLabel}
                                  onClick={() =>
                                    onJumpToChat({
                                      deviceId: targetDeviceId,
                                      botId: step.botId!,
                                      taskId: task.id,
                                      stepId: step.id,
                                    })
                                  }
                                >
                                  <GrokBotAvatar
                                    preset={asGrokAvatar(stepBot?.avatar)}
                                    botKey={`${targetDeviceId}:${step.botId}`}
                                    roleName={stepBotName}
                                    isPrimary={stepBot?.isPrimary}
                                    offline={stepBot ? stepBot.online === false : false}
                                    size={18}
                                  />
                                  <span>{stepBotName}</span>
                                </button>
                              ) : (
                                <span className="bot-unassigned">{t('等待安排', 'Unassigned')}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}

          <div>
            <button
              type="button"
              className={`disclosure-btn${logsOpen ? ' is-open' : ''}`}
              aria-expanded={logsOpen}
              aria-controls={logsBoxId}
              onClick={() => setLogsOpen(v => !v)}
            >
              <ChevronRight size={15} aria-hidden="true" />
              <span className="tabular tabular-nums">
                {t(`变更与进展记录 (${task.logs.length})`, `Activity & change log (${task.logs.length})`)}
              </span>
            </button>
            {logsOpen ? (
              <div id={logsBoxId} className="logs-box">
                {task.logs.length === 0 ? (
                  <div className="log-row">
                    <span>{t('暂无记录', 'No records yet')}</span>
                  </div>
                ) : (
                  task.logs.map(lg => (
                    <div key={lg.id} className="log-row">
                      <span className="log-time tabular tabular-nums">{formatLogTime(lg.time)}</span>
                      <span className="log-text">{lg.text}</span>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
