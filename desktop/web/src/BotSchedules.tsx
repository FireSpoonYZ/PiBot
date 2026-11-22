// 使用 Host 的调度规则与时区预览执行时间。保存仍走 scheduleTask 的 CAS 协议。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  getDefaultScheduleCalendar,
  ScheduleRule,
  type ScheduleCalendarDescription,
  type ScheduleRepeat,
} from '../../../host-core/schedule-calendar.js';
import { ConfirmDialog, InlineBanner, Select, type SelectOption } from '../../../web/src/components/ui';
import { useText } from '../../../web/src/ui';
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

type TextFn = (zh: string, en: string) => string;

const WEEKDAY_SHORT: Record<number, { zh: string; en: string }> = {
  1: { zh: '一', en: 'M' },
  2: { zh: '二', en: 'T' },
  3: { zh: '三', en: 'W' },
  4: { zh: '四', en: 'T' },
  5: { zh: '五', en: 'F' },
  6: { zh: '六', en: 'S' },
  7: { zh: '日', en: 'S' },
};

const WEEKDAY_FULL: Record<number, { zh: string; en: string }> = {
  1: { zh: '周一', en: 'Monday' },
  2: { zh: '周二', en: 'Tuesday' },
  3: { zh: '周三', en: 'Wednesday' },
  4: { zh: '周四', en: 'Thursday' },
  5: { zh: '周五', en: 'Friday' },
  6: { zh: '周六', en: 'Saturday' },
  7: { zh: '周日', en: 'Sunday' },
};

const REPEAT_PRESETS: ReadonlyArray<{ value: string; zh: string; en: string; weekdays?: number[] }> = [
  { value: 'daily', zh: '每天', en: 'Every day' },
  { value: 'statutoryWorkday', zh: '法定工作日', en: 'Statutory workdays' },
  { value: 'statutoryHoliday', zh: '法定节假日', en: 'Statutory holidays' },
  { value: 'weekdays-mon-fri', zh: '每周一至周五', en: 'Mon – Fri', weekdays: [1, 2, 3, 4, 5] },
  { value: 'weekends-sat-sun', zh: '每个周末（周六、周日）', en: 'Weekends (Sat & Sun)', weekdays: [6, 7] },
  { value: 'weekly', zh: '自定义每周几…', en: 'Custom weekdays…' },
  { value: 'monthly', zh: '每月固定日期', en: 'Monthly on day' },
  { value: 'once', zh: '单次执行', en: 'Once' },
];

function formatRepeatLabel(task: ScheduleTaskItem, t: TextFn): string {
  switch (task.repeat) {
    case 'once':
      return task.deleteAfterRun ? t('单次执行后删除', 'Once, then delete') : t('单次执行', 'Once');
    case 'daily':
      return t('每天', 'Every day');
    case 'statutoryWorkday':
      return t('法定工作日', 'Statutory workdays');
    case 'statutoryHoliday':
      return t('法定节假日', 'Statutory holidays');
    case 'monthly':
      return t(`每月 ${task.monthDay ?? 1} 日`, `Day ${task.monthDay ?? 1} monthly`);
    case 'weekly': {
      const days =
        Array.isArray(task.weekdays) && task.weekdays.length > 0
          ? task.weekdays.slice().sort((a, b) => a - b)
          : [task.weekday ?? 1];
      const key = days.join(',');
      if (key === '1,2,3,4,5') return t('每周一至周五', 'Mon – Fri');
      if (key === '6,7') return t('每周末', 'Weekends');
      const names = days.map((d) => {
        const entry = WEEKDAY_FULL[d];
        return entry ? t(entry.zh, entry.en) : String(d);
      });
      return t(`每周 ${names.join('、')}`, `Weekly: ${names.join(', ')}`);
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
  const t = useText();
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
  const [deleteTarget, setDeleteTarget] = useState<ScheduleTaskItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
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
      setError(t(`读取定时任务失败：${toError(e).message}`, `Failed to load schedules: ${toError(e).message}`));
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false);
    }
  }, [api, identity, botId, online, t]);

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

  const repeatSelectOptions = useMemo<SelectOption<string>[]>(
    () => REPEAT_PRESETS.map((o) => ({ value: o.value, label: t(o.zh, o.en) })),
    [t],
  );

  const repeatValue =
    draft.repeat === 'weekly' && !customWeekdays
      ? draft.weekdays.join(',') === '1,2,3,4,5'
        ? 'weekdays-mon-fri'
        : draft.weekdays.join(',') === '6,7'
          ? 'weekends-sat-sun'
          : 'weekly'
      : draft.repeat === 'weekly'
        ? 'weekly'
        : draft.repeat;

  function handleRepeatChange(val: string) {
    const preset = REPEAT_PRESETS.find((o) => o.value === val);
    if (preset?.weekdays) {
      setCustomWeekdays(false);
      setDraft((prev) => ({ ...prev, repeat: 'weekly', weekdays: preset.weekdays!, deleteAfterRun: false }));
    } else if (val === 'weekly') {
      setCustomWeekdays(true);
      setDraft((prev) => ({
        ...prev,
        repeat: 'weekly',
        weekdays: prev.weekdays.length > 0 ? prev.weekdays : [1],
        deleteAfterRun: false,
      }));
    } else {
      setCustomWeekdays(false);
      setDraft((prev) => ({
        ...prev,
        repeat: val as ScheduleRepeat,
        deleteAfterRun: val === 'once' ? prev.deleteAfterRun : false,
      }));
    }
  }

  function openCreate() {
    setDraft({
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
    });
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
    setDraft({
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
    });
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
      if (mountedRef.current) {
        setError(t(`切换任务状态失败：${toError(e).message}`, `Failed to toggle schedule: ${toError(e).message}`));
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function deleteTask(task: ScheduleTaskItem) {
    if (!online || busy) return;
    setBusy(true);
    setError(null);
    setDeleteError(null);
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
      if (!mountedRef.current) return;
      setDeleteTarget(null);
      setDeleteError(null);
      setEditing(null);
      setNotice(t(`已删除定时任务「${task.title}」。`, `Deleted schedule "${task.title}".`));
      await loadSchedules();
    } catch (e) {
      if (mountedRef.current) {
        const msg = t(`删除定时任务失败：${toError(e).message}`, `Failed to delete schedule: ${toError(e).message}`);
        setDeleteError(msg);
        setError(msg);
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
      setError(t('请填写任务标题与执行指令（Prompt）。', 'Please fill in both the task name and instructions (Prompt).'));
      return;
    }
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(draft.time)) {
      setError(t('触发时间格式须为 HH:mm（例如 08:30）。', 'Trigger time must be in HH:mm format (e.g. 08:30).'));
      return;
    }
    if (draft.repeat === 'weekly' && draft.weekdays.length === 0) {
      setError(t('每周重复请至少选择一个星期。', 'Select at least one weekday for weekly schedules.'));
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
        setNotice(t(`已更新定时任务「${title}」。`, `Updated schedule "${title}".`));
      } else {
        await api.call(identity, 'scheduleTask', {
          botId,
          input: {
            action: 'create',
            ...basePayload,
          },
        });
        setNotice(t(`已创建定时任务「${title}」。`, `Created schedule "${title}".`));
      }
      setEditing(null);
      await loadSchedules();
    } catch (e) {
      if (mountedRef.current) {
        setError(t(`保存定时任务失败：${toError(e).message}`, `Failed to save schedule: ${toError(e).message}`));
      }
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
      {/* Top bar: timezone caption + refresh / create actions */}
      <div className="bot-sched-topbar">
        <span className="bot-sched-count">
          <CalendarClock size={14} aria-hidden="true" />
          <span>{t('定时任务', 'Schedules')}{timeZone ? ` · ${timeZone}` : ''}</span>
        </span>
        <div className="bot-sched-topbar-actions">
          <button
            type="button"
            className="bot-sched-ghost-btn"
            onClick={() => void loadSchedules()}
            disabled={!online || loading || busy}
          >
            <RefreshCw size={13} aria-hidden="true" className={loading ? 'spinning' : undefined} />
            {loading ? t('刷新中…', 'Refreshing…') : t('刷新', 'Refresh')}
          </button>
          {!editing ? (
            <button type="button" className="bot-sched-primary-btn" onClick={openCreate} disabled={!online || busy}>
              <Plus size={14} aria-hidden="true" />
              {t('新建定时任务', 'New schedule')}
            </button>
          ) : (
            <button type="button" className="bot-sched-ghost-btn" onClick={() => setEditing(null)} disabled={busy}>
              <ChevronLeft size={14} aria-hidden="true" />
              {t('返回列表', 'Back')}
            </button>
          )}
        </div>
      </div>

      {error ? (
        <InlineBanner
          tone="danger"
          role="alert"
          compact
          title={error}
          onDismiss={() => setError(null)}
        />
      ) : null}
      {schedulingError ? (
        <InlineBanner
          tone="attention"
          role="alert"
          compact
          title={t(`调度提示：${schedulingError}`, `Schedule notice: ${schedulingError}`)}
        />
      ) : null}
      {notice ? (
        <InlineBanner
          tone="live"
          role="status"
          compact
          title={notice}
          onDismiss={() => setNotice(null)}
        />
      ) : null}

      {editing ? (
        /* ————— Create / Edit form (flat hairline sections) ————— */
        <div className="bot-sched-form">
          <h5 className="bot-sched-form-title">
            {editing === 'edit' ? t('编辑定时任务', 'Edit schedule') : t('新建定时任务', 'New schedule')}
          </h5>

          <div className="bot-sched-section">
            <span className="bot-sched-section-label">{t('做什么', 'What to run')}</span>
            <div className="bot-sched-group">
              <div className="bot-sched-textarea-wrap">
                <label className="bot-sched-field-label" htmlFor="bot-sched-prompt">{t('执行内容', 'Instructions')}</label>
                <textarea
                  id="bot-sched-prompt"
                  rows={4}
                  value={draft.prompt}
                  disabled={busy}
                  placeholder={t('例如，汇总今天的日程与待办事项。', 'e.g., Summarize today’s calendar and open to-dos.')}
                  onChange={(e) => setDraft((prev) => ({ ...prev, prompt: e.target.value }))}
                />
              </div>
              <label className="bot-sched-row">
                <span className="bot-sched-row-label">{t('任务名称', 'Task name')}</span>
                <input
                  type="text"
                  maxLength={80}
                  className="bot-sched-text-input"
                  value={draft.title}
                  disabled={busy}
                  placeholder={t('例如：每日早报汇总 / 定时代码巡检', 'e.g., Morning briefing / Scheduled audit')}
                  onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
                />
              </label>
            </div>
          </div>

          <div className="bot-sched-section">
            <span className="bot-sched-section-label">{t('何时做', 'When to run')}</span>
            <div className="bot-sched-group">
              <label className="bot-sched-row">
                <span className="bot-sched-row-label">{t('触发时间', 'Time')}</span>
                <input
                  type="time"
                  className="bot-sched-time-input"
                  value={draft.time}
                  disabled={busy}
                  onChange={(e) => setDraft((prev) => ({ ...prev, time: e.target.value }))}
                />
              </label>
              <div className="bot-sched-row">
                <label className="bot-sched-row-label" htmlFor="bot-sched-repeat">{t('重复周期', 'Repeat')}</label>
                <Select
                  id="bot-sched-repeat"
                  className="bot-sched-select"
                  size="sm"
                  ariaLabel={t('重复周期', 'Repeat')}
                  value={repeatValue}
                  disabled={busy}
                  options={repeatSelectOptions}
                  onChange={handleRepeatChange}
                />
              </div>

              {draft.repeat === 'once' ? (
                <label className="bot-sched-row">
                  <span className="bot-sched-row-label">{t('执行日期（可选）', 'Date (optional)')}</span>
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
                <div className="bot-sched-row bot-sched-weekday-row" role="group" aria-label={t('选择星期', 'Select weekdays')}>
                  {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                    const active = draft.weekdays.includes(day);
                    const full = WEEKDAY_FULL[day];
                    const short = WEEKDAY_SHORT[day];
                    return (
                      <button
                        key={day}
                        type="button"
                        className={`bot-sched-weekday-chip${active ? ' active' : ''}`}
                        aria-pressed={active}
                        aria-label={full ? t(full.zh, full.en) : String(day)}
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
                        {short ? t(short.zh, short.en) : day}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {draft.repeat === 'monthly' ? (
                <label className="bot-sched-row">
                  <span className="bot-sched-row-label">{t('每月几号', 'Day of month')}</span>
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
            <details className="bot-sched-disclosure">
              <summary>
                <ChevronRight size={13} className="bot-sched-disclosure-chevron" aria-hidden="true" />
                <span>{t('更多安排', 'More options')}</span>
              </summary>
              <div className="bot-sched-group bot-sched-disclosure-body">
                {showReminders ? (
                  <>
                    <div className="bot-sched-row">
                      <span className="bot-sched-row-label">{t('使用 Android 系统闹钟', 'Use Android alarm clock')}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={draft.alarmMode === 'alarmClock'}
                        aria-label={t('使用 Android 系统闹钟', 'Use Android alarm clock')}
                        className={`bot-sched-toggle${draft.alarmMode === 'alarmClock' ? ' checked' : ''}`}
                        disabled={busy}
                        onClick={() =>
                          setDraft((prev) => ({
                            ...prev,
                            alarmMode: prev.alarmMode === 'alarmClock' ? 'exact' : 'alarmClock',
                          }))
                        }
                      >
                        <span className="bot-sched-toggle-knob" />
                      </button>
                    </div>
                    {draft.alarmMode === 'exact' && exactAlarmGranted === false ? (
                      <p className="bot-sched-hint bot-sched-preview">
                        {t('设备需要精确闹钟权限才能使用普通定时模式。', 'Exact alarm permission is required on this device for standard scheduling.')}
                      </p>
                    ) : null}
                    {draft.alarmMode === 'alarmClock' ? (
                      <div className="bot-sched-row">
                        <span className="bot-sched-row-label">{t('任务完成时震动（设备支持时）', 'Vibrate when finished (if supported)')}</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={draft.vibrate}
                          aria-label={t('任务完成时震动（设备支持时）', 'Vibrate when finished (if supported)')}
                          className={`bot-sched-toggle${draft.vibrate ? ' checked' : ''}`}
                          disabled={busy}
                          onClick={() => setDraft((prev) => ({ ...prev, vibrate: !prev.vibrate }))}
                        >
                          <span className="bot-sched-toggle-knob" />
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : null}
                {draft.repeat === 'once' ? (
                  <div className="bot-sched-row">
                    <span className="bot-sched-row-label">{t('触发后自动删除任务', 'Delete automatically after running')}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={draft.deleteAfterRun}
                      aria-label={t('触发后自动删除任务', 'Delete automatically after running')}
                      className={`bot-sched-toggle${draft.deleteAfterRun ? ' checked' : ''}`}
                      disabled={busy}
                      onClick={() => setDraft((prev) => ({ ...prev, deleteAfterRun: !prev.deleteAfterRun }))}
                    >
                      <span className="bot-sched-toggle-knob" />
                    </button>
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}

          <div className="bot-sched-preview" role="status">
            {!draft.enabled
              ? t('任务已暂停，恢复后会重新安排执行。', 'Schedule is paused and will be rescheduled once enabled.')
              : preview
                ? (
                  <>
                    {t('按目标时区预计执行 · ', 'Next run in target timezone · ')}
                    <strong className="tabular-nums">{preview.time}</strong> · {timeZone}
                  </>
                )
                : targetNow === null || !timeZone
                  ? t('等待目标设备提供时间与时区。', 'Waiting for target device clock and timezone.')
                  : t('请填写有效的执行时间与周期以预览。', 'Enter a valid time and repeat rule to preview.')}
            {preview?.calendarNotice ? (
              <p className="bot-sched-hint">
                {preview.calendarNotice}{preview.calendarFallback ? `，${preview.calendarFallback}。` : '。'}
              </p>
            ) : null}
          </div>
          <div className="bot-sched-form-actions">
            <button type="button" className="bot-sched-primary-btn" onClick={() => void saveDraft()} disabled={busy || !online}>
              {busy ? t('保存中…', 'Saving…') : t('保存定时任务', 'Save schedule')}
            </button>
            <button type="button" className="bot-sched-ghost-btn" onClick={() => setEditing(null)} disabled={busy}>
              {t('取消', 'Cancel')}
            </button>
          </div>
        </div>
      ) : tasks.length === 0 ? (
        <div className="bot-sched-empty">
          <CalendarClock size={24} aria-hidden="true" />
          <span>
            {loading
              ? t('正在读取定时任务…', 'Loading schedules…')
              : t('暂无定时任务。可以新建任务，或在对话中交给智能体。', 'No schedules yet. Create one here or ask the agent in chat.')}
          </span>
        </div>
      ) : (
        /* ————— Flat hairline task list ————— */
        <div className="bot-sched-list">
          {tasks.map((task) => {
            const isEnabled = task.enabled !== false;
            const nextRun = formatNextRun(task.nextRunAt, timeZone, Boolean(task.date));
            return (
              <section key={task.id} className={`bot-sched-card${isEnabled ? '' : ' paused'}`}>
                <div className="bot-sched-card-top">
                  <button
                    type="button"
                    className="bot-sched-card-body"
                    disabled={!online || busy}
                    onClick={() => openEdit(task)}
                  >
                    <strong className="bot-sched-title">{task.title || t('未命名定时任务', 'Untitled schedule')}</strong>
                    <span className="bot-sched-next">
                      {isEnabled
                        ? (
                          <>
                            {t('下次执行 · ', 'Next run · ')}
                            {nextRun ? `${nextRun} · ${timeZone}` : t('等待设备安排', 'Pending device schedule')}
                          </>
                        )
                        : t('已暂停', 'Paused')}
                    </span>
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isEnabled}
                    aria-label={isEnabled ? t('暂停该任务', 'Pause schedule') : t('启用该任务', 'Enable schedule')}
                    className={`bot-sched-toggle${isEnabled ? ' checked' : ''}`}
                    disabled={!online || busy}
                    onClick={() => void toggleEnabled(task)}
                  >
                    <span className="bot-sched-toggle-knob" />
                  </button>
                </div>
                <details className="bot-sched-disclosure">
                  <summary>
                    <ChevronRight size={13} className="bot-sched-disclosure-chevron" aria-hidden="true" />
                    <span>{t('任务详情', 'Details')}</span>
                  </summary>
                  <div className="bot-sched-detail">
                    <p className="bot-sched-meta tabular-nums">{formatRepeatLabel(task, t)} · {task.time}</p>
                    {task.prompt ? <p className="bot-sched-prompt">{task.prompt}</p> : null}
                    {task.latestRun ? (
                      <p className="bot-sched-meta">
                        {t('最近运行状态 · ', 'Latest run · ')}{task.latestRun.status}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className="bot-sched-ghost-btn bot-sched-danger-btn"
                      disabled={!online || busy}
                      onClick={(event) => {
                        deleteTriggerRef.current = event.currentTarget;
                        setDeleteError(null);
                        setDeleteTarget(task);
                      }}
                    >
                      <Trash2 size={13} aria-hidden="true" /> {t('删除任务', 'Delete schedule')}
                    </button>
                  </div>
                </details>
              </section>
            );
          })}
        </div>
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('删除定时任务', 'Delete schedule')}
        description={
          deleteTarget
            ? t(
                `确定要删除定时任务「${deleteTarget.title || '未命名定时任务'}」吗？删除后将不再按计划触发，此操作不可撤销。`,
                `Delete schedule "${deleteTarget.title || 'Untitled schedule'}"? It will no longer run and this action cannot be undone.`,
              )
            : ''
        }
        danger
        busy={busy}
        disabled={!online}
        error={deleteError}
        cancelLabel={t('取消', 'Cancel')}
        confirmLabel={busy ? t('删除中…', 'Deleting…') : t('删除任务', 'Delete schedule')}
        onCancel={() => {
          if (!busy) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        onConfirm={() => {
          if (!deleteTarget || !online || busy) return;
          void deleteTask(deleteTarget);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (deleteTriggerRef.current?.isConnected) {
            deleteTriggerRef.current.focus();
          }
          deleteTriggerRef.current = null;
        }}
      />
    </div>
  );
}
