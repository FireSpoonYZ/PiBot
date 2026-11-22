// 使用 Host 的调度规则与时区预览执行时间。保存仍走 scheduleTask 的 CAS 协议。
import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, ChevronLeft, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { getDefaultScheduleCalendar, ScheduleRule, type ScheduleCalendarDescription, type ScheduleRepeat } from '../../../host-core/schedule-calendar.js';
import { ActionBar, ConfirmDialog, IconButton, Switch, useDirtyForm } from '../../../web/src/components/ui';
import { toError } from './api';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import './BotSchedules.css';

interface ScheduleTaskItem {
  id: string;
  revision: number;
  enabled: boolean;
  title: string;
  prompt?: string;
  repeat: ScheduleRepeat;
  time: string;
  date?: string;
  weekday?: number;
  weekdays?: number[];
  monthDay?: number;
  alarmMode?: 'exact' | 'alarmClock';
  vibrate?: boolean;
  deleteAfterRun?: boolean;
  nextRunAt?: number;
  latestRun?: {
    status: string;
    occurrence: number;
    submissionStatus?: string;
    finishedAt?: number;
  } | null;
}

interface ScheduleDraft {
  id?: string;
  revision?: number;
  enabled: boolean;
  title: string;
  prompt: string;
  repeat: ScheduleRepeat;
  time: string;
  date?: string;
  weekdays: number[];
  monthDay: number;
  alarmMode: 'exact' | 'alarmClock';
  vibrate: boolean;
  deleteAfterRun: boolean;
}

const WEEKDAY_NAMES: Record<number, string> = {
  1: '一',
  2: '二',
  3: '三',
  4: '四',
  5: '五',
  6: '六',
  7: '日',
};

const WEEKDAY_FULL_NAMES: Record<number, string> = {
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  7: '周日',
};

function formatRepeatLabel(task: ScheduleTaskItem): string {
  switch (task.repeat) {
    case 'once':
      return task.deleteAfterRun ? '单次执行后删除' : '单次执行';
    case 'daily':
      return '每天';
    case 'statutoryWorkday':
      return '法定工作日';
    case 'statutoryHoliday':
      return '法定节假日';
    case 'monthly':
      return `每月 ${task.monthDay ?? 1} 日`;
    case 'weekly': {
      const days =
        Array.isArray(task.weekdays) && task.weekdays.length > 0
          ? task.weekdays.slice().sort((a, b) => a - b)
          : [task.weekday ?? 1];
      const key = days.join(',');
      if (key === '1,2,3,4,5') return '每周一至周五';
      if (key === '6,7') return '每周末';
      return `每周 ${days.map((d) => WEEKDAY_FULL_NAMES[d] ?? d).join('、')}`;
    }
    default:
      return task.repeat;
  }
}

function formatNextRun(nextRunAt: number | undefined, timeZone: string, includeYear: boolean): string | null {
  if (!nextRunAt || nextRunAt <= 0 || !timeZone) return null;
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: includeYear ? 'numeric' : undefined,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(nextRunAt));
  } catch {
    return null;
  }
}

function scheduleRuleFields(draft: ScheduleDraft) {
  return {
    repeat: draft.repeat,
    time: draft.time,
    ...(draft.repeat === 'once' && draft.date ? { date: draft.date } : {}),
    ...(draft.repeat === 'weekly' ? { weekdays: draft.weekdays.slice().sort((a, b) => a - b) } : {}),
    ...(draft.repeat === 'monthly' ? { monthDay: Math.min(31, Math.max(1, Math.round(draft.monthDay))) } : {}),
  };
}

function previewNextRun(draft: ScheduleDraft, now: number | null, timeZone: string) {
  if (!draft.enabled || now === null || !timeZone) return null;
  try {
    const rule = ScheduleRule.fromJson(scheduleRuleFields(draft));
    const calendar = getDefaultScheduleCalendar();
    const next = rule.nextAfter(now, timeZone, calendar);
    const calendarInfo: ScheduleCalendarDescription = {};
    calendar.describe(calendarInfo, rule, now, next, timeZone);
    const time = formatNextRun(next, timeZone, draft.repeat === 'once' && Boolean(draft.date));
    return time ? { time, ...calendarInfo } : null;
  } catch {
    return null;
  }
}

const REPEAT_OPTIONS: { value: string; label: string; weekdays?: number[] }[] = [
  { value: 'daily', label: '每天' },
  { value: 'statutoryWorkday', label: '法定工作日' },
  { value: 'statutoryHoliday', label: '法定节假日' },
  { value: 'weekdays-mon-fri', label: '每周一至周五', weekdays: [1, 2, 3, 4, 5] },
  { value: 'weekends-sat-sun', label: '每个周末（周六、周日）', weekdays: [6, 7] },
  { value: 'weekly', label: '自定义每周几…' },
  { value: 'monthly', label: '每月固定日期' },
  { value: 'once', label: '单次执行' },
];

export function BotSchedules({
  api,
  identity,
  botId,
  hostPlatform,
}: {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  botId: string;
  hostPlatform?: string;
}) {
  const online = api.transportConnected;
  const [tasks, setTasks] = useState<ScheduleTaskItem[]>([]);
  const [timeZone, setTimeZone] = useState<string>('');
  const [hostClock, setHostClock] = useState<{ now: number; sampledAt: number } | null>(null);
  const [previewSample, setPreviewSample] = useState(Date.now);
  const [exactAlarmGranted, setExactAlarmGranted] = useState<boolean | null>(null);
  const [schedulingError, setSchedulingError] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduleTaskItem | null>(null);
  /** 自定义星期选择展开态：repeat=weekly 且非周一~五/周末预设时为 true。 */
  const [customWeekdays, setCustomWeekdays] = useState(false);
  const [draft, setDraft] = useState<ScheduleDraft>({
    enabled: true,
    title: '',
    prompt: '',
    repeat: 'daily',
    time: '08:00',
    weekdays: [1, 2, 3, 4, 5],
    monthDay: 1,
    alarmMode: 'exact',
    vibrate: false,
    deleteAfterRun: false,
  });
  const initialDraftSnapshotRef = useRef<string>('');

  const isDraftDirty = editing !== null && JSON.stringify(draft) !== initialDraftSnapshotRef.current;
  useDirtyForm(isDraftDirty);

  const mountedRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSchedules = useCallback(async () => {
    if (!online) return;
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const res = (await api.call(identity, 'scheduleTask', {
        botId,
        input: { action: 'list', limit: 50 },
      })) as Record<string, unknown>;
      if (!mountedRef.current || seq !== seqRef.current) return;
      const list = Array.isArray(res.tasks) ? (res.tasks as ScheduleTaskItem[]) : [];
      setTasks(list);
      setTimeZone(typeof res.timeZone === 'string' ? res.timeZone : '');
      setHostClock(typeof res.now === 'number' && Number.isFinite(res.now) && res.now > 0
        ? { now: res.now, sampledAt: Date.now() }
        : null);
      setExactAlarmGranted(typeof res.exactAlarmGranted === 'boolean' ? res.exactAlarmGranted : null);
      setSchedulingError(typeof res.schedulingError === 'string' ? res.schedulingError : '');
      setError(null);
    } catch (e) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setError(`读取定时任务失败：${toError(e).message}`);
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false);
    }
  }, [api, identity, botId, online]);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  useEffect(() => {
    if (!editing || !hostClock || !online) return;
    setPreviewSample(Date.now());
    const timer = setInterval(() => setPreviewSample(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [editing, hostClock, online]);

  // 桌面 Host 也返回 exactAlarmGranted=true，但只有 Android 通过 AlarmManager 调度。
  const showReminders = hostPlatform === 'android' && exactAlarmGranted !== null;

  function openCreate() {
    const nextDraft: ScheduleDraft = {
      enabled: true,
      title: '',
      prompt: '',
      repeat: 'daily',
      time: '08:00',
      weekdays: [1, 2, 3, 4, 5],
      monthDay: 1,
      alarmMode: hostPlatform === 'android' ? 'alarmClock' : 'exact',
      vibrate: showReminders,
      deleteAfterRun: false,
    };
    initialDraftSnapshotRef.current = JSON.stringify(nextDraft);
    setDraft(nextDraft);
    setCustomWeekdays(false);
    setEditing('new');
    setError(null);
    setNotice(null);
  }

  function openEdit(task: ScheduleTaskItem) {
    const days =
      Array.isArray(task.weekdays) && task.weekdays.length > 0
        ? task.weekdays.slice().sort((a, b) => a - b)
        : [task.weekday ?? 1];
    const key = days.join(',');
    const nextDraft: ScheduleDraft = {
      id: task.id,
      revision: task.revision,
      enabled: task.enabled !== false,
      title: task.title,
      prompt: task.prompt ?? '',
      repeat: task.repeat,
      time: task.time || '08:00',
      date: task.date,
      weekdays: days,
      monthDay: task.monthDay ?? 1,
      alarmMode: task.alarmMode === 'exact' ? 'exact' : 'alarmClock',
      vibrate: Boolean(task.vibrate),
      deleteAfterRun: Boolean(task.deleteAfterRun),
    };
    initialDraftSnapshotRef.current = JSON.stringify(nextDraft);
    setDraft(nextDraft);
    setCustomWeekdays(task.repeat === 'weekly' && key !== '1,2,3,4,5' && key !== '6,7');
    setEditing('edit');
    setError(null);
    setNotice(null);
  }

  async function toggleEnabled(task: ScheduleTaskItem) {
    if (!online || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.call(identity, 'scheduleTask', {
        botId,
        input: {
          action: 'setEnabled',
          id: task.id,
          revision: task.revision,
          enabled: task.enabled === false,
        },
      });
      await loadSchedules();
    } catch (e) {
      if (mountedRef.current) setError(`切换任务状态失败：${toError(e).message}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function deleteTask(task: ScheduleTaskItem) {
    if (!online || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.call(identity, 'scheduleTask', {
        botId,
        input: {
          action: 'delete',
          id: task.id,
          revision: task.revision,
        },
      });
      setPendingDelete(null);
      setEditing(null);
      setNotice(`已删除定时任务「${task.title}」。`);
      await loadSchedules();
    } catch (e) {
      if (mountedRef.current) {
        setPendingDelete(null);
        setError(`删除定时任务失败：${toError(e).message}，请刷新后重试。`);
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function saveDraft() {
    if (!online || busy) return;
    const title = draft.title.trim();
    const prompt = draft.prompt.trim();
    if (!title || !prompt) {
      setError('请填写任务标题与执行指令（Prompt）。');
      return;
    }
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(draft.time)) {
      setError('触发时间格式须为 HH:mm（例如 08:30）。');
      return;
    }
    if (draft.repeat === 'weekly' && draft.weekdays.length === 0) {
      setError('每周重复请至少选择一个星期。');
      return;
    }

    const basePayload = {
      title,
      prompt,
      ...scheduleRuleFields(draft),
      alarmMode: draft.alarmMode,
      vibrate: draft.vibrate,
      deleteAfterRun: draft.deleteAfterRun,
    };

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (editing === 'edit' && draft.id && draft.revision) {
        await api.call(identity, 'scheduleTask', {
          botId,
          input: {
            action: 'update',
            id: draft.id,
            revision: draft.revision,
            ...basePayload,
            ...(draft.repeat === 'once' && draft.date === '' ? { date: null } : {}),
          },
        });
        setNotice(`已更新定时任务「${title}」。`);
      } else {
        await api.call(identity, 'scheduleTask', {
          botId,
          input: {
            action: 'create',
            ...basePayload,
          },
        });
        setNotice(`已创建定时任务「${title}」。`);
      }
      setEditing(null);
      await loadSchedules();
    } catch (e) {
      if (mountedRef.current) setError(`保存定时任务失败：${toError(e).message}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const targetNow = online && hostClock
    ? hostClock.now + Math.max(0, previewSample - hostClock.sampledAt)
    : null;
  const preview = editing ? previewNextRun(draft, targetNow, timeZone) : null;

  return (
    <div className="bot-schedules-panel">
      {/* 顶栏：时区元信息 + 刷新图标按钮 + 新建定时任务（编辑态切为返回列表头） */}
      <div
        className="bot-sched-topbar"
        style={{
          flexWrap: 'nowrap',
          paddingBottom: 'var(--space-2)',
          borderBottom: '1px solid var(--line-subtle)',
        }}
      >
        {editing ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
            <button type="button" className="bot-sched-ghost-btn" onClick={() => setEditing(null)} disabled={busy}>
              <ChevronLeft size={14} aria-hidden="true" />
              返回列表
            </button>
            <h5
              className="bot-sched-form-title"
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {editing === 'edit' ? '编辑定时任务' : '新建定时任务'}
            </h5>
          </div>
        ) : (
          <>
            <span
              className="bot-sched-count"
              style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={timeZone ? `${tasks.length} 项定时任务 · ${timeZone}` : `${tasks.length} 项定时任务`}
            >
              <CalendarClock size={14} aria-hidden="true" style={{ flex: 'none' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {timeZone ? `${tasks.length} 项 · ${timeZone}` : `${tasks.length} 项任务`}
              </span>
            </span>
            <div className="bot-sched-topbar-actions" style={{ flexWrap: 'nowrap' }}>
              <IconButton
                label="刷新定时任务"
                size="sm"
                variant="ghost"
                onClick={() => void loadSchedules()}
                disabled={!online || loading || busy}
              >
                <RefreshCw size={15} aria-hidden="true" className={loading ? 'spinning' : undefined} />
              </IconButton>
              <button type="button" className="bot-sched-primary-btn" onClick={openCreate} disabled={!online || busy}>
                <Plus size={14} aria-hidden="true" />
                新建定时任务
              </button>
            </div>
          </>
        )}
      </div>

      {error ? (
        <div className="bot-sched-banner bot-sched-banner-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>关闭提示</button>
        </div>
      ) : null}
      {schedulingError ? (
        <div className="bot-sched-banner bot-sched-banner-warn" role="alert">
          {`调度提示：${schedulingError}`}
        </div>
      ) : null}
      {notice ? <div className="bot-sched-banner bot-sched-banner-ok" role="status">{notice}</div> : null}

      {editing ? (
        /* ————— 新建 / 编辑单列表单 ————— */
        <div className="bot-sched-form">
          <div className="bot-sched-section">
            <span className="bot-sched-section-label">做什么</span>
            <div className="bot-sched-group">
              <div className="bot-sched-textarea-wrap">
                <label className="bot-sched-section-label" htmlFor="bot-sched-title" style={{ padding: 0 }}>任务名称</label>
                <input
                  id="bot-sched-title"
                  type="text"
                  maxLength={80}
                  className="bot-sched-text-input"
                  style={{
                    width: '100%',
                    border: 0,
                    background: 'transparent',
                    padding: 0,
                    fontSize: '0.9rem',
                    color: 'var(--text)',
                    outline: 'none',
                  }}
                  value={draft.title}
                  disabled={busy}
                  placeholder="例如：每日早报汇总 / 定时代码巡检"
                  onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
                />
              </div>
              <div className="bot-sched-textarea-wrap">
                <label className="bot-sched-section-label" htmlFor="bot-sched-prompt" style={{ padding: 0 }}>执行内容</label>
                <textarea
                  id="bot-sched-prompt"
                  rows={4}
                  value={draft.prompt}
                  disabled={busy}
                  placeholder="例如，汇总今天的日程与待办事项。"
                  onChange={(e) => setDraft((prev) => ({ ...prev, prompt: e.target.value }))}
                />
              </div>
            </div>
          </div>

          <div className="bot-sched-section">
            <span className="bot-sched-section-label">何时做</span>
            <div className="bot-sched-group">
              <label className="bot-sched-row">
                <span className="bot-sched-row-label">触发时间</span>
                <input
                  type="time"
                  className="bot-sched-time-input"
                  value={draft.time}
                  disabled={busy}
                  onChange={(e) => setDraft((prev) => ({ ...prev, time: e.target.value }))}
                />
              </label>
              <div className="bot-sched-row">
                <label className="bot-sched-row-label" htmlFor="bot-sched-repeat">重复周期</label>
                <select
                  id="bot-sched-repeat"
                  className="bot-sched-select"
                  value={
                    draft.repeat === 'weekly' && !customWeekdays
                      ? draft.weekdays.join(',') === '1,2,3,4,5'
                        ? 'weekdays-mon-fri'
                        : draft.weekdays.join(',') === '6,7'
                          ? 'weekends-sat-sun'
                          : 'weekly'
                      : draft.repeat === 'weekly'
                        ? 'weekly'
                        : draft.repeat
                  }
                  disabled={busy}
                  onChange={(e) => {
                    const val = e.target.value;
                    const preset = REPEAT_OPTIONS.find((o) => o.value === val);
                    if (preset?.weekdays) {
                      setCustomWeekdays(false);
                      setDraft((prev) => ({ ...prev, repeat: 'weekly', weekdays: preset.weekdays!, deleteAfterRun: false }));
                    } else if (val === 'weekly') {
                      setCustomWeekdays(true);
                      setDraft((prev) => ({ ...prev, repeat: 'weekly', weekdays: prev.weekdays.length > 0 ? prev.weekdays : [1], deleteAfterRun: false }));
                    } else {
                      setCustomWeekdays(false);
                      setDraft((prev) => ({ ...prev, repeat: val as ScheduleRepeat, deleteAfterRun: val === 'once' ? prev.deleteAfterRun : false }));
                    }
                  }}
                >
                  {REPEAT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {draft.repeat === 'once' ? (
                <label className="bot-sched-row">
                  <span className="bot-sched-row-label">执行日期（可选）</span>
                  <input
                    type="date"
                    className="bot-sched-time-input"
                    max="9999-12-31"
                    value={draft.date ?? ''}
                    disabled={busy}
                    onChange={(e) => setDraft((prev) => ({ ...prev, date: e.target.value }))}
                  />
                </label>
              ) : null}

              {draft.repeat === 'weekly' && customWeekdays ? (
                <div className="bot-sched-row bot-sched-weekday-row" role="group" aria-label="选择重复星期">
                  {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                    const active = draft.weekdays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        className={`bot-sched-weekday-chip${active ? ' active' : ''}`}
                        aria-pressed={active}
                        aria-label={WEEKDAY_FULL_NAMES[day]}
                        disabled={busy}
                        onClick={() =>
                          setDraft((prev) => {
                            const exists = prev.weekdays.includes(day);
                            const next = exists
                              ? prev.weekdays.filter((d) => d !== day)
                              : [...prev.weekdays, day].sort((a, b) => a - b);
                            return { ...prev, weekdays: next };
                          })
                        }
                      >
                        {WEEKDAY_NAMES[day]}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {draft.repeat === 'monthly' ? (
                <label className="bot-sched-row">
                  <span className="bot-sched-row-label">每月几号</span>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    className="bot-sched-num-input"
                    value={draft.monthDay}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        monthDay: Math.min(31, Math.max(1, Number(e.target.value) || 1)),
                      }))
                    }
                  />
                </label>
              ) : null}
            </div>
          </div>

          {showReminders || draft.repeat === 'once' ? (
            <details className="bot-studio-disclosure">
              <summary>更多安排</summary>
              <div className="bot-sched-group">
                {showReminders ? (
                  <>
                    <div className="bot-sched-row">
                      <span className="bot-sched-row-label">使用 Android 系统闹钟</span>
                      <Switch
                        checked={draft.alarmMode === 'alarmClock'}
                        aria-label="使用 Android 系统闹钟"
                        disabled={busy}
                        onCheckedChange={(checked) =>
                          setDraft((prev) => ({
                            ...prev,
                            alarmMode: checked ? 'alarmClock' : 'exact',
                          }))
                        }
                      />
                    </div>
                    {draft.alarmMode === 'exact' && exactAlarmGranted === false ? (
                      <p className="hint bot-sched-preview">设备需要精确闹钟权限才能使用普通定时模式。</p>
                    ) : null}
                    {draft.alarmMode === 'alarmClock' ? (
                      <div className="bot-sched-row">
                        <span className="bot-sched-row-label">任务完成时震动（设备支持时）</span>
                        <Switch
                          checked={draft.vibrate}
                          aria-label="任务完成时震动（设备支持时）"
                          disabled={busy}
                          onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, vibrate: checked }))}
                        />
                      </div>
                    ) : null}
                  </>
                ) : null}
                {draft.repeat === 'once' ? (
                  <div className="bot-sched-row">
                    <span className="bot-sched-row-label">触发后自动删除任务</span>
                    <Switch
                      checked={draft.deleteAfterRun}
                      aria-label="触发后自动删除任务"
                      disabled={busy}
                      onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, deleteAfterRun: checked }))}
                    />
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}

          <div className="bot-sched-preview" role="status" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {!draft.enabled ? '任务已暂停，恢复后会重新安排执行。'
              : preview ? <>按目标时区预计执行 · <strong>{preview.time}</strong> · {timeZone}</>
                : targetNow === null || !timeZone ? '等待目标设备提供时间与时区。' : '请填写有效的执行时间与周期以预览。'}
            {preview?.calendarNotice ? <p className="hint">{preview.calendarNotice}{preview.calendarFallback ? '，' + preview.calendarFallback + '。' : '。'}</p> : null}
          </div>

          <ActionBar align="end" className="bot-sched-form-actions" style={{ flexWrap: 'nowrap' }}>
            <button type="button" className="bot-sched-ghost-btn" onClick={() => setEditing(null)} disabled={busy}>
              取消
            </button>
            <button type="button" className="bot-sched-primary-btn" onClick={() => void saveDraft()} disabled={busy || !online}>
              {busy ? '保存中…' : '保存定时任务'}
            </button>
          </ActionBar>
        </div>
      ) : tasks.length === 0 ? (
        <div className="bot-sched-empty metadata">
          <CalendarClock size={26} aria-hidden="true" />
          {loading
            ? '正在读取定时任务…'
            : '暂无定时任务。可点击上方「新建定时任务」，或在对话中交给智能体安排。'}
        </div>
      ) : (
        /* ————— 扁平分割线任务列表 ————— */
        <div className="bot-sched-list" style={{ gap: 0 }}>
          {tasks.map((task) => {
            const isEnabled = task.enabled !== false;
            const taskTitle = task.title || '未命名定时任务';
            const nextRun = formatNextRun(task.nextRunAt, timeZone, Boolean(task.date));
            return (
              <section
                key={task.id}
                className={`bot-sched-card${isEnabled ? '' : ' paused'}`}
                style={{
                  padding: '12px 0',
                  border: 0,
                  borderBottom: '1px solid var(--line-subtle)',
                  borderRadius: 0,
                  background: 'transparent',
                }}
              >
                <div className="bot-sched-card-top" style={{ flexWrap: 'nowrap', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="bot-sched-card-body"
                    style={{ flex: 1, minWidth: 0 }}
                    disabled={!online || busy}
                    onClick={() => openEdit(task)}
                  >
                    <strong className="bot-sched-title">{taskTitle}</strong>
                    <span className="bot-sched-next" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatRepeatLabel(task)} {task.time} ·{' '}
                      {isEnabled ? (nextRun ? `下次 ${nextRun}` : '等待设备安排') : '已暂停'}
                    </span>
                  </button>
                  <Switch
                    checked={isEnabled}
                    aria-label={isEnabled ? `暂停定时任务「${taskTitle}」` : `启用定时任务「${taskTitle}」`}
                    disabled={!online || busy}
                    onCheckedChange={() => void toggleEnabled(task)}
                  />
                </div>
                <details className="bot-studio-disclosure">
                  <summary>任务详情</summary>
                  <div className="bot-sched-detail">
                    {task.prompt ? <p className="bot-sched-prompt">{task.prompt}</p> : null}
                    {isEnabled && nextRun && timeZone ? (
                      <p className="metadata" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        下次预计执行 · {nextRun}（{timeZone}）
                      </p>
                    ) : null}
                    {task.latestRun ? <p className="metadata">最近运行状态 · {task.latestRun.status}</p> : null}
                    <ActionBar align="start" style={{ flexWrap: 'nowrap', marginTop: 4 }}>
                      <button
                        type="button"
                        className="bot-sched-ghost-btn"
                        disabled={!online || busy}
                        onClick={() => openEdit(task)}
                      >
                        <Pencil size={13} aria-hidden="true" />
                        编辑任务
                      </button>
                      <button
                        type="button"
                        className="bot-sched-ghost-btn"
                        style={{
                          color: 'var(--danger)',
                          borderColor: 'color-mix(in srgb, var(--danger) 35%, var(--line))',
                        }}
                        disabled={!online || busy}
                        onClick={() => setPendingDelete(task)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        删除任务
                      </button>
                    </ActionBar>
                  </div>
                </details>
              </section>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除定时任务"
        description={
          pendingDelete
            ? `确定删除定时任务「${pendingDelete.title || '未命名定时任务'}」？删除后将不再按计划执行，且无法撤销。`
            : ''
        }
        danger
        busy={busy}
        cancelLabel="取消"
        confirmLabel={busy ? '删除中…' : '删除任务'}
        onCancel={() => {
          if (!busy) setPendingDelete(null);
        }}
        onConfirm={() => {
          if (pendingDelete) void deleteTask(pendingDelete);
        }}
      />
    </div>
  );
}
