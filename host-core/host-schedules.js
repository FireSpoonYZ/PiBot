// host-core/host-schedules.js
// Unified Host Schedule Manager:
// - When nativeBridge is provided (Android Host), delegates to Android's
//   BotHostSchedules (AlarmManager + files/bot-host/schedules.sqlite).
// - When nativeBridge is absent (Windows/Linux Desktop & Server Node Host),
//   persists to dataRoot/schedules.sqlite with the exact same schema, CAS
//   revision semantics, pre-send claim state machine, and recurrence rules.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { messageError } from './message-protocol.js';
import {
  ScheduleRule,
  getDefaultScheduleCalendar,
  resolveSystemTimeZone,
} from './schedule-calendar.js';
import {
  assertCanonicalUuid,
  assertPositiveRevision,
  normalizeScheduleTaskInput,
  validateScheduleTaskFields,
} from './schedule-protocol.js';

const STATE_VERSION = 1;
const MAX_TASKS = 100;
const MAX_ACTIVE_RUNS = 32;
const MAX_TOTAL_RUNS = 100;
const DEFAULT_LIST_LIMIT = 20;
const WAKE_INTERVAL_MS = 5_000;
const RETRY_DELAY_MS = 2_000;
const MAX_TIMER_MS = 60_000;
const SOURCE_PREFIX = 'Scheduled task; not an authenticated human message';

const TERMINAL_RUNS = new Set([
  'done',
  'unanswered',
  'not_sent',
  'skipped_offline',
  'skipped_capacity',
]);
const ACTIVE_RUNS = new Set(['dispatching', 'unconfirmed', 'queued', 'placed']);
const SUBMISSION_TERMINAL = new Set(['done', 'unanswered']);
const SUBMISSION_ACTIVE = new Set(['queued', 'placed']);
const NOT_SENT_ERROR_CODES = new Set([
  'INVALID_ARGUMENT',
  'INVALID_CWD',
  'BOT_NOT_FOUND',
  'BOT_ARCHIVED',
  'MODEL_REQUIRED',
  'MODEL_NOT_FOUND',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storeError(message) {
  return messageError('STORE_FAILED', message);
}

function conflictError(message) {
  return messageError('REQUEST_CONFLICT', message);
}

function invalidError(message) {
  return messageError('INVALID_ARGUMENT', message);
}

function stableRequestId(taskId, revision, occurrence) {
  return createHash('sha256')
    .update(`${taskId}|${revision}|${occurrence}`, 'utf8')
    .digest('hex');
}

function ownerOf(value) {
  return isPlainObject(value?.owner) ? value.owner : {};
}

function ownerMatches(value, owner) {
  const stored = ownerOf(value);
  return (
    Boolean(owner) &&
    stored.deviceId === owner.deviceId &&
    stored.botId === owner.botId &&
    stored.conversationId === owner.conversationId
  );
}

function ownerEq(a, b) {
  const ob = ownerOf(b);
  return ownerMatches(a, {
    deviceId: ob.deviceId,
    botId: ob.botId,
    conversationId: ob.conversationId,
  });
}

function latestRunSummary(runs, taskId) {
  let best = null;
  let bestOccurrence = -1;
  for (const run of runs) {
    if (run.taskId !== taskId) continue;
    const occ = typeof run.occurrence === 'number' ? run.occurrence : -1;
    if (best === null || occ >= bestOccurrence) {
      best = run;
      bestOccurrence = occ;
    }
  }
  if (!best) return null;
  const summary = {
    status: best.status,
    occurrence: best.occurrence,
  };
  if (typeof best.submissionStatus === 'string') {
    summary.submissionStatus = best.submissionStatus;
  }
  if (typeof best.finishedAt === 'number') {
    summary.finishedAt = best.finishedAt;
  }
  return summary;
}

function taskDTO(task, runs) {
  const dto = {};
  const keys = [
    'id',
    'revision',
    'enabled',
    'title',
    'prompt',
    'repeat',
    'time',
    'weekday',
    'weekdays',
    'monthDay',
    'alarmMode',
    'vibrate',
    'deleteAfterRun',
    'nextRunAt',
    'sourceTaskId',
    'createdAt',
    'updatedAt',
  ];
  for (const key of keys) {
    if (task[key] !== undefined) {
      dto[key] = Array.isArray(task[key]) ? task[key].slice() : task[key];
    }
  }
  dto.latestRun = latestRunSummary(runs, task.id);
  return dto;
}

export function createScheduleManager({ host, getRuntime, isOnline, nativeBridge }) {
  if (nativeBridge) {
    function actorFor(bot) {
      return {
        deviceId: host.deviceId,
        botId: bot.botId,
        conversationId: bot.primaryConversationId,
        scopeId: null,
        kind: 'primary',
      };
    }

    return {
      start() {},
      notifyOnline() {},
      async execute(bot, input, options = {}) {
        const normalized = normalizeScheduleTaskInput(input);
        const taskId =
          Number.isSafeInteger(options.taskId) && options.taskId > 0 ? options.taskId : 1;
        options.signal?.throwIfAborted();
        const result = await nativeBridge(
          {
            tool: 'schedule_task',
            actor: actorFor(bot),
            taskId,
            arguments: normalized,
          },
          { signal: options.signal },
        );
        options.signal?.throwIfAborted();
        if (!isPlainObject(result)) {
          throw storeError('定时任务原生响应无效');
        }
        return result;
      },
      async pauseBot(bot) {
        try {
          await nativeBridge({
            tool: 'schedule_task',
            actor: actorFor(bot),
            taskId: 1,
            arguments: { action: 'pauseBot' },
          });
        } catch {
          /* best effort cleanup when host/bridge is not bound */
        }
      },
      async deleteBot(bot) {
        try {
          await nativeBridge({
            tool: 'schedule_task',
            actor: actorFor(bot),
            taskId: 1,
            arguments: { action: 'deleteBot' },
          });
        } catch {
          /* best effort cleanup when host/bridge is not bound */
        }
      },
      async close() {},
    };
  }

  // ---- Node SQLite Schedule Engine (Desktop / Server Host) ----
  const dbPath = join(host.dataRoot, 'schedules.sqlite');
  const calendar = getDefaultScheduleCalendar();
  let db = null;
  let closed = false;
  let ready = false;
  let alarmTimer = null;
  let wakeTimer = null;
  let inflight = null;
  let lastPlanIndex = 0;

  function openDb() {
    if (db) return db;
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const fresh = !existsSync(dbPath);
    const opened = new DatabaseSync(dbPath);
    try {
      if (fresh) {
        opened.exec('BEGIN IMMEDIATE');
        try {
          opened.exec(
            'CREATE TABLE state(id INTEGER NOT NULL PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL)',
          );
          const initial = JSON.stringify({
            version: STATE_VERSION,
            tasks: [],
            runs: [],
            schedulingError: '',
            timeZone: '',
          });
          opened
            .prepare('INSERT INTO state(id, version, json) VALUES(1, ?, ?)')
            .run(STATE_VERSION, initial);
          opened.exec('COMMIT');
        } catch (err) {
          try {
            opened.exec('ROLLBACK');
          } catch {
            /* ignore */
          }
          throw err;
        }
      } else {
        loadFromDb(opened);
      }
      db = opened;
      return db;
    } catch (err) {
      try {
        opened.close();
      } catch {
        /* ignore */
      }
      throw err?.code ? err : storeError(err?.message || '定时任务存储损坏');
    }
  }

  function loadFromDb(database) {
    let rows;
    try {
      rows = database.prepare('SELECT id, version, json FROM state').all();
    } catch {
      throw storeError('定时任务存储损坏');
    }
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw storeError('定时任务存储缺失');
    }
    const row = rows[0];
    if (row.id !== 1) {
      throw storeError('定时任务存储缺失');
    }
    if (row.version !== STATE_VERSION) {
      throw messageError('UNSUPPORTED_SCHEMA', '定时任务存储版本不受支持');
    }
    if (typeof row.json !== 'string') {
      throw storeError('定时任务存储损坏');
    }
    let parsed;
    try {
      parsed = JSON.parse(row.json);
    } catch {
      throw storeError('定时任务存储损坏');
    }
    if (!isPlainObject(parsed) || parsed.version !== STATE_VERSION) {
      throw messageError('UNSUPPORTED_SCHEMA', '定时任务存储版本不受支持');
    }
    if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.runs)) {
      throw storeError('定时任务存储损坏');
    }
    return {
      json: parsed,
      tasks: parsed.tasks,
      runs: parsed.runs,
      schedulingError: typeof parsed.schedulingError === 'string' ? parsed.schedulingError : '',
    };
  }

  function saveToDb(database, st) {
    st.json.version = STATE_VERSION;
    st.json.tasks = st.tasks;
    st.json.runs = st.runs;
    st.json.schedulingError = st.schedulingError;
    st.json.timeZone = resolveSystemTimeZone();
    database
      .prepare('UPDATE state SET version = ?, json = ? WHERE id = 1')
      .run(STATE_VERSION, JSON.stringify(st.json));
  }

  function inTx(action) {
    const database = openDb();
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = action(database);
      database.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  function nextAfter(task, afterMs, zoneId) {
    try {
      return ScheduleRule.fromJson(task).nextAfter(afterMs, zoneId, calendar);
    } catch (err) {
      throw invalidError(err?.message || '重复规则无效');
    }
  }

  function alarmStatus(st, zoneId) {
    return {
      exactAlarmGranted: true,
      schedulingError: st.schedulingError || '',
      timeZone: zoneId,
      now: Date.now(),
    };
  }

  function describeStatutory(result, tasks, zoneId) {
    if (!Array.isArray(tasks) || tasks.length === 0) return;
    for (const task of tasks) {
      try {
        const rule = ScheduleRule.fromJson(task);
        if (rule.isStatutory()) {
          calendar.describe(result, rule, Date.now(), task.nextRunAt || Date.now(), zoneId);
          return;
        }
      } catch {
        /* ignore malformed calendar rule */
      }
    }
  }

  function mutationResult(st, task) {
    const zoneId = resolveSystemTimeZone();
    const result = {
      ...alarmStatus(st, zoneId),
      task: taskDTO(task, st.runs),
    };
    describeStatutory(result, [task], zoneId);
    return result;
  }

  function indexOfTask(st, owner, id) {
    for (let i = 0; i < st.tasks.length; i += 1) {
      const task = st.tasks[i];
      if (task.id === id && (owner === null || ownerMatches(task, owner))) {
        return i;
      }
    }
    return -1;
  }

  function activeRunCount(st) {
    let count = 0;
    for (const run of st.runs) {
      if (ACTIVE_RUNS.has(run.status)) count += 1;
    }
    return count;
  }

  function trimRuns(st) {
    while (st.runs.length > MAX_TOTAL_RUNS) {
      const oldestIdx = st.runs.findIndex((r) => TERMINAL_RUNS.has(r.status));
      if (oldestIdx < 0) break;
      st.runs.splice(oldestIdx, 1);
    }
  }

  function newRun(taskId, task, occurrence, revision) {
    const now = Date.now();
    const taskOwner = ownerOf(task);
    return {
      id: randomUUID(),
      taskId,
      revision,
      occurrence,
      requestId: stableRequestId(taskId, revision, occurrence),
      prompt: task.prompt,
      vibrate: Boolean(task.vibrate),
      deleteAfterRun: Boolean(task.deleteAfterRun),
      owner: {
        deviceId: taskOwner.deviceId,
        botId: taskOwner.botId,
        conversationId: taskOwner.conversationId,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  function newTask(owner, input, id, sourceTaskId, now, zoneId) {
    const task = {
      id,
      revision: 1,
      enabled: true,
      sourceTaskId,
      createdAt: now,
      updatedAt: now,
      owner: {
        deviceId: owner.deviceId,
        botId: owner.botId,
        conversationId: owner.conversationId,
      },
      title: input.title,
      prompt: input.prompt,
      repeat: input.repeat,
      time: input.time,
      alarmMode: input.alarmMode ?? 'alarmClock',
      vibrate: Boolean(input.vibrate),
      deleteAfterRun: Boolean(input.deleteAfterRun),
    };
    if (input.weekday !== undefined) task.weekday = input.weekday;
    if (input.weekdays !== undefined) task.weekdays = input.weekdays.slice();
    if (input.monthDay !== undefined) task.monthDay = input.monthDay;
    validateScheduleTaskFields(task);
    task.nextRunAt = nextAfter(task, now, zoneId);
    return task;
  }

  function scheduleAlarmsLocked(st) {
    if (alarmTimer) {
      clearTimeout(alarmTimer);
      alarmTimer = null;
    }
    st.schedulingError = '';
    if (closed || !ready) return;
    let earliest = Infinity;
    for (const task of st.tasks) {
      if (task.enabled === false) continue;
      const due = typeof task.nextRunAt === 'number' ? task.nextRunAt : 0;
      if (due > 0 && due < earliest) earliest = due;
    }
    if (!Number.isFinite(earliest)) return;
    const delayMs = Math.min(MAX_TIMER_MS, Math.max(0, earliest - Date.now()));
    alarmTimer = setTimeout(() => {
      alarmTimer = null;
      onAlarm();
    }, delayMs);
    alarmTimer.unref?.();
  }

  function dispatchOccurrence(st, task, due, now, zoneId) {
    const run = newRun(task.id, task, due, task.revision);
    if (activeRunCount(st) >= MAX_ACTIVE_RUNS) {
      run.status = 'skipped_capacity';
      run.reason = 'capacity';
      run.finishedAt = now;
      run.submitted = true;
    } else {
      run.status = 'dispatching';
      run.submitted = false;
    }
    st.runs.push(run);
    trimRuns(st);
    if (task.repeat === 'once') {
      task.enabled = false;
      task.nextRunAt = 0;
    } else {
      task.nextRunAt = nextAfter(task, now, zoneId);
    }
  }

  function onAlarm() {
    if (closed || !ready) return;
    try {
      inTx((database) => {
        const st = loadFromDb(database);
        const now = Date.now();
        const zoneId = resolveSystemTimeZone();
        for (const task of st.tasks) {
          if (task.enabled === false) continue;
          const due = typeof task.nextRunAt === 'number' ? task.nextRunAt : 0;
          if (due <= 0 || due > now) continue;
          dispatchOccurrence(st, task, due, now, zoneId);
        }
        saveToDb(database, st);
        scheduleAlarmsLocked(st);
        saveToDb(database, st);
      });
    } catch {
      /* ignore transient dispatch error */
    }
    drive();
  }

  function neutralizeNeverAttempted(st) {
    const now = Date.now();
    for (const run of st.runs) {
      if (run.status !== 'dispatching' || run.submitted) continue;
      run.status = 'skipped_offline';
      run.reason = 'offline';
      run.finishedAt = now;
      run.submitted = true;
    }
  }

  function markMissedLocked(st) {
    const now = Date.now();
    const zoneId = resolveSystemTimeZone();
    for (const task of st.tasks) {
      if (task.enabled === false) continue;
      const due = typeof task.nextRunAt === 'number' ? task.nextRunAt : 0;
      if (due <= 0 || due > now) continue;
      const run = newRun(task.id, task, due, task.revision);
      run.status = 'skipped_offline';
      run.reason = 'offline';
      run.finishedAt = now;
      run.submitted = true;
      st.runs.push(run);
      trimRuns(st);
      if (task.repeat === 'once') {
        task.enabled = false;
        task.nextRunAt = 0;
      } else {
        task.nextRunAt = nextAfter(task, now, zoneId);
      }
    }
  }

  function scheduleWakeIfActive() {
    if (closed || !ready) return;
    let hasActive = false;
    try {
      const st = loadFromDb(openDb());
      hasActive = st.runs.some((r) => ACTIVE_RUNS.has(r.status));
    } catch {
      return;
    }
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    if (hasActive) {
      wakeTimer = setTimeout(() => {
        wakeTimer = null;
        drive();
      }, WAKE_INTERVAL_MS);
      wakeTimer.unref?.();
    }
  }

  function scheduleRetry() {
    if (closed || !ready) return;
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      drive();
    }, RETRY_DELAY_MS);
    wakeTimer.unref?.();
  }

  function planStepLocked() {
    try {
      return inTx((database) => {
        const st = loadFromDb(database);
        const n = st.runs.length;
        if (n === 0) return null;
        const start = (lastPlanIndex + 1) % n;
        for (let k = 0; k < n; k += 1) {
          const i = (start + k) % n;
          const run = st.runs[i];
          const status = run.status;
          const submitted = Boolean(run.submitted);
          if (status === 'dispatching' && !submitted) {
            const task = st.tasks.find((t) => t.id === run.taskId);
            const bot = host.getBot(ownerOf(run).botId);
            if (!task || !bot || bot.archivedAt) {
              run.status = 'skipped_offline';
              run.reason = !task ? 'task_deleted' : 'bot_unavailable';
              run.finishedAt = Date.now();
              run.submitted = true;
              saveToDb(database, st);
              continue;
            }
            lastPlanIndex = i;
            return { kind: 'submit', runId: run.id, run: structuredClone(run) };
          }
          if (submitted && (status === 'unconfirmed' || SUBMISSION_ACTIVE.has(status))) {
            lastPlanIndex = i;
            return { kind: 'getSubmission', runId: run.id, run: structuredClone(run) };
          }
        }
        return null;
      });
    } catch {
      return null;
    }
  }

  function claimPreSend(runId) {
    try {
      return inTx((database) => {
        const st = loadFromDb(database);
        const run = st.runs.find((r) => r.id === runId);
        if (!run || run.status !== 'dispatching' || run.submitted) return false;
        run.submitted = true;
        run.status = 'unconfirmed';
        run.updatedAt = Date.now();
        saveToDb(database, st);
        return true;
      });
    } catch {
      return false;
    }
  }

  function finishDoneLocked(st, run) {
    const task = st.tasks.find((t) => t.id === run.taskId);
    if (task && task.revision === run.revision && ownerEq(task, run) && run.deleteAfterRun) {
      const idx = indexOfTask(st, null, run.taskId);
      if (idx >= 0) {
        st.tasks.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  function settle(step, result, error) {
    if (inflight !== step) return;
    inflight = null;
    if (closed || !ready) return;
    let status = null;
    let deleted = false;
    try {
      status = inTx((database) => {
        const st = loadFromDb(database);
        const run = st.runs.find((r) => r.id === step.runId);
        if (!run) return null;
        const now = Date.now();
        if (error) {
          if (
            step.kind === 'submit' &&
            (error.outcome === 'not-sent' || NOT_SENT_ERROR_CODES.has(error.code))
          ) {
            run.status = 'not_sent';
            run.reason = 'not_sent';
            run.finishedAt = now;
          } else {
            run.status = 'unconfirmed';
            run.submitted = true;
          }
          run.updatedAt = now;
        } else if (!isPlainObject(result)) {
          run.status = 'unconfirmed';
          run.submitted = true;
          run.updatedAt = now;
        } else {
          const runOwner = ownerOf(run);
          const subStatus = result.status;
          const subId = result.submissionId;
          if (
            result.botId !== runOwner.botId ||
            result.conversationId !== runOwner.conversationId ||
            result.requestId !== run.requestId ||
            typeof subStatus !== 'string' ||
            (!SUBMISSION_TERMINAL.has(subStatus) && !SUBMISSION_ACTIVE.has(subStatus)) ||
            !Number.isSafeInteger(subId) ||
            subId <= 0
          ) {
            run.status = 'unconfirmed';
            run.submitted = true;
            run.updatedAt = now;
          } else {
            run.submissionStatus = subStatus;
            run.submissionId = subId;
            if (SUBMISSION_TERMINAL.has(subStatus)) {
              run.status = subStatus;
              run.finishedAt = now;
            } else {
              run.status = subStatus;
            }
            run.submitted = true;
            run.updatedAt = now;
          }
        }
        saveToDb(database, st);
        if (run.status === 'done') {
          deleted = finishDoneLocked(st, run);
          if (deleted) {
            scheduleAlarmsLocked(st);
          }
          saveToDb(database, st);
        }
        return run.status;
      });
    } catch {
      /* ignore settle error */
    }
    if (status && ACTIVE_RUNS.has(status)) {
      scheduleRetry();
    } else {
      drive();
    }
  }

  function drive() {
    if (closed || !ready || inflight) return;
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    const step = planStepLocked();
    if (!step) {
      scheduleWakeIfActive();
      return;
    }
    const rt = getRuntime?.();
    if (!rt || (typeof isOnline === 'function' && !isOnline())) {
      scheduleRetry();
      return;
    }
    inflight = step;
    if (step.kind === 'submit') {
      if (!claimPreSend(step.runId)) {
        inflight = null;
        scheduleRetry();
        return;
      }
    }
    const botId = ownerOf(step.run).botId;
    const requestId = step.run.requestId;
    let promise;
    try {
      promise =
        step.kind === 'submit'
          ? rt.submit(botId, {
              requestId,
              text: `${SOURCE_PREFIX} ${step.run.prompt}`,
              // 内部计划任务是可信 host 来源输入：稳定 requestId + host 归属，
              // 与用户私聊轮共享准入但不冒名 user。
              origin: { sender: { kind: 'host' }, replyTo: null },
            })
          : rt.getSubmission(botId, requestId);
    } catch (err) {
      settle(step, null, err);
      return;
    }
    Promise.resolve(promise).then(
      (res) => settle(step, res, null),
      (err) => settle(step, null, err),
    );
  }

  function createOp(owner, input, sourceTaskId) {
    return inTx((database) => {
      const st = loadFromDb(database);
      if (st.tasks.length >= MAX_TASKS) {
        throw conflictError('任务数已达上限');
      }
      const now = Date.now();
      const zoneId = resolveSystemTimeZone();
      const id = randomUUID();
      const task = newTask(owner, input, id, sourceTaskId, now, zoneId);
      st.tasks.push(task);
      saveToDb(database, st);
      scheduleAlarmsLocked(st);
      saveToDb(database, st);
      return mutationResult(st, task);
    });
  }

  function updateOp(owner, input) {
    return inTx((database) => {
      const st = loadFromDb(database);
      const id = assertCanonicalUuid(input.id, 'id');
      const revision = assertPositiveRevision(input.revision);
      const index = indexOfTask(st, owner, id);
      if (index < 0) throw conflictError('任务不存在');
      const task = st.tasks[index];
      if (task.revision !== revision) {
        throw conflictError('任务已被修改，请刷新后重试');
      }
      const merged = structuredClone(task);
      for (const [key, value] of Object.entries(input)) {
        if (key === 'action' || key === 'id' || key === 'revision') continue;
        merged[key] = Array.isArray(value) ? value.slice() : value;
      }
      if (input.weekday !== undefined && input.weekdays === undefined) delete merged.weekdays;
      if (input.weekdays !== undefined && input.weekday === undefined) delete merged.weekday;
      validateScheduleTaskFields(merged);
      const now = Date.now();
      const zoneId = resolveSystemTimeZone();
      if (merged.enabled !== false) {
        merged.nextRunAt = nextAfter(merged, now, zoneId);
      } else {
        merged.nextRunAt = 0;
      }
      merged.revision = revision + 1;
      merged.updatedAt = now;
      st.tasks[index] = merged;
      saveToDb(database, st);
      scheduleAlarmsLocked(st);
      saveToDb(database, st);
      return mutationResult(st, merged);
    });
  }

  function deleteOp(owner, input) {
    return inTx((database) => {
      const st = loadFromDb(database);
      const id = assertCanonicalUuid(input.id, 'id');
      const revision = assertPositiveRevision(input.revision);
      const index = indexOfTask(st, owner, id);
      if (index < 0) throw conflictError('任务不存在');
      if (st.tasks[index].revision !== revision) {
        throw conflictError('任务已被修改，请刷新后重试');
      }
      st.tasks.splice(index, 1);
      saveToDb(database, st);
      scheduleAlarmsLocked(st);
      saveToDb(database, st);
      const zoneId = resolveSystemTimeZone();
      return {
        ...alarmStatus(st, zoneId),
        deleted: id,
      };
    });
  }

  function setEnabledOp(owner, input) {
    return inTx((database) => {
      const st = loadFromDb(database);
      const id = assertCanonicalUuid(input.id, 'id');
      const revision = assertPositiveRevision(input.revision);
      if (typeof input.enabled !== 'boolean') throw invalidError('enabled 必须是布尔值');
      const index = indexOfTask(st, owner, id);
      if (index < 0) throw conflictError('任务不存在');
      const task = st.tasks[index];
      if (task.revision !== revision) {
        throw conflictError('任务已被修改，请刷新后重试');
      }
      const merged = structuredClone(task);
      merged.enabled = input.enabled;
      const now = Date.now();
      const zoneId = resolveSystemTimeZone();
      if (input.enabled) {
        if ((merged.nextRunAt || 0) <= now) {
          merged.nextRunAt = nextAfter(merged, now, zoneId);
        }
      } else {
        merged.nextRunAt = 0;
      }
      merged.revision = revision + 1;
      merged.updatedAt = now;
      st.tasks[index] = merged;
      saveToDb(database, st);
      scheduleAlarmsLocked(st);
      saveToDb(database, st);
      return mutationResult(st, merged);
    });
  }

  function listOp(owner, input) {
    return inTx((database) => {
      const st = loadFromDb(database);
      const cursor = input.cursor !== undefined ? assertCanonicalUuid(input.cursor, 'cursor') : null;
      const limit = input.limit !== undefined ? input.limit : DEFAULT_LIST_LIMIT;
      const matched = st.tasks.filter((task) => {
        if (!ownerMatches(task, owner)) return false;
        if (cursor !== null && task.id.localeCompare(cursor) <= 0) return false;
        return true;
      });
      matched.sort((a, b) => a.id.localeCompare(b.id));
      const count = Math.min(limit, matched.length);
      const nextCursor = count < matched.length ? matched[count - 1].id : null;
      const pageTasks = matched.slice(0, count);
      const pageDtos = pageTasks.map((t) => taskDTO(t, st.runs));
      const zoneId = resolveSystemTimeZone();
      const result = {
        ...alarmStatus(st, zoneId),
        tasks: pageDtos,
        nextCursor,
      };
      describeStatutory(result, pageTasks, zoneId);
      return result;
    });
  }

  return {
    start() {
      if (closed || ready) return;
      try {
        inTx((database) => {
          const st = loadFromDb(database);
          neutralizeNeverAttempted(st);
          markMissedLocked(st);
          saveToDb(database, st);
          ready = true;
          scheduleAlarmsLocked(st);
          saveToDb(database, st);
        });
      } catch {
        return;
      }
      drive();
    },

    notifyOnline() {
      if (closed || !ready) return;
      drive();
    },

    async execute(bot, input, options = {}) {
      if (closed) throw messageError('NOT_CONNECTED', 'host is closing');
      const normalized = normalizeScheduleTaskInput(input);
      if (normalized.action === 'requestExactAlarm') {
        return { requested: true, exactAlarmGranted: true };
      }
      const owner = {
        deviceId: host.deviceId,
        botId: bot.botId,
        conversationId: bot.primaryConversationId,
      };
      const sourceTaskId =
        Number.isSafeInteger(options.taskId) && options.taskId > 0 ? options.taskId : 1;
      switch (normalized.action) {
        case 'create':
          return createOp(owner, normalized, sourceTaskId);
        case 'update':
          return updateOp(owner, normalized);
        case 'delete':
          return deleteOp(owner, normalized);
        case 'setEnabled':
          return setEnabledOp(owner, normalized);
        case 'list':
          return listOp(owner, normalized);
        default:
          throw invalidError(`未知操作: ${normalized.action}`);
      }
    },

    async pauseBot(bot) {
      if (closed) return;
      try {
        inTx((database) => {
          const st = loadFromDb(database);
          const owner = {
            deviceId: host.deviceId,
            botId: bot.botId,
            conversationId: bot.primaryConversationId,
          };
          let changed = false;
          const now = Date.now();
          for (const task of st.tasks) {
            if (ownerMatches(task, owner) && task.enabled !== false) {
              task.enabled = false;
              task.nextRunAt = 0;
              task.revision = (task.revision || 1) + 1;
              task.updatedAt = now;
              changed = true;
            }
          }
          if (changed) {
            saveToDb(database, st);
            scheduleAlarmsLocked(st);
            saveToDb(database, st);
          }
        });
      } catch {
        /* best effort */
      }
    },

    async deleteBot(bot) {
      if (closed) return;
      try {
        inTx((database) => {
          const st = loadFromDb(database);
          const owner = {
            deviceId: host.deviceId,
            botId: bot.botId,
            conversationId: bot.primaryConversationId,
          };
          const before = st.tasks.length;
          st.tasks = st.tasks.filter((task) => !ownerMatches(task, owner));
          const now = Date.now();
          for (const run of st.runs) {
            if (ownerMatches(run, owner) && run.status === 'dispatching' && !run.submitted) {
              run.status = 'skipped_offline';
              run.reason = 'task_deleted';
              run.finishedAt = now;
              run.submitted = true;
            }
          }
          if (st.tasks.length !== before) {
            saveToDb(database, st);
            scheduleAlarmsLocked(st);
            saveToDb(database, st);
          } else {
            saveToDb(database, st);
          }
        });
      } catch {
        /* best effort */
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      ready = false;
      inflight = null;
      if (alarmTimer) {
        clearTimeout(alarmTimer);
        alarmTimer = null;
      }
      if (wakeTimer) {
        clearTimeout(wakeTimer);
        wakeTimer = null;
      }
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        db = null;
      }
    },
  };
}
