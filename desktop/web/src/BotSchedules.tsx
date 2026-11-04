// 手机与桌面共用的 Bot 定时任务面板。
// 通过远端/本机统一控制协议 `scheduleTask` 读写目标 Bot 的主私聊定时任务（CAS 乐观锁）。
// 桌面端视觉重构（Lane 6）：时钟卡片/周期徽章/启用拨动开关/分组编辑表单；
// 桌面专属样式以 .desktop-shell/.desktop-dialog 作用域，不污染手机端；props/数据/CAS 语义不变。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Pencil, Trash2, CalendarClock, ChevronLeft } from 'lucide-react';
import { toError } from './api';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import './BotSchedules.css';

type ScheduleRepeat =
  | 'once'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'statutoryWorkday'
  | 'statutoryHoliday';

interface ScheduleTaskItem {
  id: string;
  revision: number;
  enabled: boolean;
  title: string;
  prompt?: string;
  repeat: ScheduleRepeat;
  time: string;
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
  title: string;
  prompt: string;
  repeat: ScheduleRepeat;
  time: string;
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

function formatNextRun(nextRunAt?: number, timeZone?: string): string {
  if (!nextRunAt || nextRunAt <= 0) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timeZone || undefined,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(nextRunAt));
  } catch {
    return new Date(nextRunAt).toLocaleString();
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
}: {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  botId: string;
}) {
  const online = api.transportConnected;
  const [tasks, setTasks] = useState<ScheduleTaskItem[]>([]);
  const [timeZone, setTimeZone] = useState<string>('');
  const [schedulingError, setSchedulingError] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null);
  /** 自定义星期选择展开态：repeat=weekly 且非周一~五/周末预设时为 true。 */
  const [customWeekdays, setCustomWeekdays] = useState(false);
  const [draft, setDraft] = useState<ScheduleDraft>({
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

  function openCreate() {
    setDraft({
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
      setEditing(null);
      setNotice(`已删除定时任务「${task.title}」。`);
      await loadSchedules();
    } catch (e) {
      if (mountedRef.current) setError(`删除定时任务失败：${toError(e).message}`);
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

    const basePayload: Record<string, unknown> = {
      title,
      prompt,
      repeat: draft.repeat,
      time: draft.time,
      alarmMode: draft.alarmMode,
      vibrate: draft.vibrate,
      deleteAfterRun: draft.deleteAfterRun,
    };
    if (draft.repeat === 'weekly') {
      basePayload.weekdays = draft.weekdays.slice().sort((a, b) => a - b);
    } else if (draft.repeat === 'monthly') {
      basePayload.monthDay = Math.min(31, Math.max(1, Math.round(draft.monthDay)));
    }

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

  const enabledCount = tasks.filter((task) => task.enabled !== false).length;

  return (
    <div className="bot-schedules-panel">
      {/* 顶栏：任务统计 + 刷新/新建 */}
      <div className="bot-sched-topbar metadata">
        <span className="bot-sched-count">
          <CalendarClock size={14} aria-hidden="true" />
          {`共 ${tasks.length} 个定时任务（${enabledCount} 个启用）${timeZone ? ` · 时区 ${timeZone}` : ''}`}
        </span>
        <div className="bot-sched-topbar-actions">
          <button type="button" className="bot-sched-ghost-btn" onClick={() => void loadSchedules()} disabled={!online || loading || busy}>
            <RefreshCw size={13} aria-hidden="true" className={loading ? 'spinning' : undefined} />
            {loading ? '刷新中…' : '刷新'}
          </button>
          {!editing ? (
            <button type="button" className="bot-sched-primary-btn" onClick={openCreate} disabled={!online || busy}>
              <Plus size={14} aria-hidden="true" />
              新建定时任务
            </button>
          ) : (
            <button type="button" className="bot-sched-ghost-btn" onClick={() => setEditing(null)} disabled={busy}>
              <ChevronLeft size={14} aria-hidden="true" />
              返回列表
            </button>
          )}
        </div>
      </div>

      {error ? (
        <div className="bot-sched-banner bot-sched-banner-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>关闭</button>
        </div>
      ) : null}
      {schedulingError ? (
        <div className="bot-sched-banner bot-sched-banner-warn" role="alert">
          {`调度提示：${schedulingError}`}
        </div>
      ) : null}
      {notice ? <div className="bot-sched-banner bot-sched-banner-ok" role="status">{notice}</div> : null}

      {editing ? (
        /* ————— 新建 / 编辑表单（分组卡片 + 拨动开关） ————— */
        <div className="bot-sched-form">
          <h5 className="bot-sched-form-title">
            {editing === 'edit' ? `编辑定时任务（revision ${draft.revision}）` : '新建定时任务'}
          </h5>

          {/* 时间与周期 */}
          <div className="bot-sched-section">
            <span className="bot-sched-section-label">执行时间与周期</span>
            <div className="bot-sched-group">
              <label className="bot-sched-row">
                <span className="bot-sched-row-label">触发时间</span>
                <input
                  type="time"
                  className="bot-sched-time-input"
                  value={draft.time}
                  disabled={busy}
                  onChange={(e) => setDraft((prev) => ({ ...prev, time: e.target.value || '08:00' }))}
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

              {draft.repeat === 'weekly' && customWeekdays ? (
                <div className="bot-sched-row bot-sched-weekday-row">
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

          {/* 标题与指令 */}
          <div className="bot-sched-section">
            <span className="bot-sched-section-label">任务标题与执行指令</span>
            <div className="bot-sched-group">
              <label className="bot-sched-row">
                <span className="bot-sched-row-label">任务名称</span>
                <input
                  type="text"
                  maxLength={80}
                  className="bot-sched-text-input"
                  value={draft.title}
                  disabled={busy}
                  placeholder="例如：每日早报汇总 / 定时代码巡检"
                  onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
                />
              </label>
              <div className="bot-sched-textarea-wrap">
                <label className="bot-sched-sr-only" htmlFor="bot-sched-prompt">到点发送给该 Bot 的指令</label>
                <textarea
                  id="bot-sched-prompt"
                  rows={4}
                  value={draft.prompt}
                  disabled={busy}
                  placeholder="到点后发送给该 Bot 执行的指令内容，例如：汇总今天的日程与待办事项，并生成简短提醒。"
                  onChange={(e) => setDraft((prev) => ({ ...prev, prompt: e.target.value }))}
                />
              </div>
            </div>
          </div>

          {/* 提醒与状态 */}
          <div className="bot-sched-section">
            <span className="bot-sched-section-label">提醒方式与状态</span>
            <div className="bot-sched-group">
              <div className="bot-sched-row">
                <span className="bot-sched-row-label">强提醒模式（响铃与弹窗）</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={draft.alarmMode === 'alarmClock'}
                  aria-label="强提醒模式（响铃与弹窗）"
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
              {draft.alarmMode === 'alarmClock' ? (
                <div className="bot-sched-row">
                  <span className="bot-sched-row-label">震动提醒</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.vibrate}
                    aria-label="震动提醒"
                    className={`bot-sched-toggle${draft.vibrate ? ' checked' : ''}`}
                    disabled={busy}
                    onClick={() => setDraft((prev) => ({ ...prev, vibrate: !prev.vibrate }))}
                  >
                    <span className="bot-sched-toggle-knob" />
                  </button>
                </div>
              ) : null}
              {draft.repeat === 'once' ? (
                <div className="bot-sched-row">
                  <span className="bot-sched-row-label">触发后自动删除任务</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.deleteAfterRun}
                    aria-label="触发后自动删除任务"
                    className={`bot-sched-toggle${draft.deleteAfterRun ? ' checked' : ''}`}
                    disabled={busy}
                    onClick={() => setDraft((prev) => ({ ...prev, deleteAfterRun: !prev.deleteAfterRun }))}
                  >
                    <span className="bot-sched-toggle-knob" />
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="bot-sched-form-actions">
            <button type="button" className="bot-sched-primary-btn" onClick={() => void saveDraft()} disabled={busy || !online}>
              {busy ? '保存中…' : '保存定时任务'}
            </button>
            <button type="button" className="bot-sched-ghost-btn" onClick={() => setEditing(null)} disabled={busy}>
              取消
            </button>
          </div>
        </div>
      ) : tasks.length === 0 ? (
        <div className="bot-sched-empty metadata">
          <CalendarClock size={26} aria-hidden="true" />
          {loading
            ? '正在读取定时任务…'
            : '当前 Bot 暂无定时任务。可点击上方“＋ 新建定时任务”，或在聊天中直接让 Bot 使用 schedule_task 工具创建。'}
        </div>
      ) : (
        /* ————— 时钟卡片列表 ————— */
        <div className="bot-sched-list">
          {tasks.map((task) => {
            const isEnabled = task.enabled !== false;
            return (
              <section key={task.id} className={`bot-sched-card${isEnabled ? '' : ' paused'}`}>
                <div className="bot-sched-card-top">
                  <button
                    type="button"
                    className="bot-sched-card-time-wrap"
                    disabled={!online || busy}
                    onClick={() => openEdit(task)}
                  >
                    <span className="bot-sched-time">{task.time || '未设置'}</span>
                    <div className="bot-sched-badges">
                      <span className="bot-sched-badge">{formatRepeatLabel(task)}</span>
                      <span className={`bot-sched-badge ${task.alarmMode === 'alarmClock' ? 'alarm' : 'silent'}`}>
                        {task.alarmMode === 'alarmClock' ? '🔔 强提醒' : '⚡ 后台执行'}
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isEnabled}
                    aria-label={isEnabled ? '暂停该任务' : '启用该任务'}
                    className={`bot-sched-toggle${isEnabled ? ' checked' : ''}`}
                    disabled={!online || busy}
                    onClick={() => void toggleEnabled(task)}
                  >
                    <span className="bot-sched-toggle-knob" />
                  </button>
                </div>

                <button
                  type="button"
                  className="bot-sched-card-body"
                  disabled={!online || busy}
                  onClick={() => openEdit(task)}
                >
                  <div className="bot-sched-title">{task.title || '未命名定时任务'}</div>
                  {task.prompt ? <div className="bot-sched-prompt">{task.prompt}</div> : null}
                </button>

                <div className="bot-sched-card-footer">
                  <span className="bot-sched-next">
                    {isEnabled
                      ? `下次执行：${formatNextRun(task.nextRunAt, timeZone)} · rev ${task.revision}${task.latestRun ? ` · 最近执行: ${task.latestRun.status}` : ''}`
                      : `已暂停 · rev ${task.revision}`}
                  </span>
                  <div className="bot-sched-actions">
                    <button
                      type="button"
                      className="bot-sched-icon-btn"
                      aria-label="编辑"
                      disabled={!online || busy}
                      onClick={() => openEdit(task)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      className="bot-sched-icon-btn danger"
                      aria-label="删除"
                      disabled={!online || busy}
                      onClick={() => void deleteTask(task)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
