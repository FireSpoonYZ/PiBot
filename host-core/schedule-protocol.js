// host-core/schedule-protocol.js
// Pure boundary validation for scheduled task tool & control inputs.
// No node:* or runtime dependencies so both Host and client bundles can import it.

import { assertId, messageError } from './message-protocol.js';
import { SCHEDULE_REPEATS, ScheduleRule } from './schedule-calendar.js';

const REPEATS_SET = new Set(SCHEDULE_REPEATS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME_RE = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const ALARM_MODES = new Set(['alarmClock', 'exact']);

const CREATE_FIELDS = new Set([
  'action',
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
]);

const UPDATE_FIELDS = new Set([
  'action',
  'id',
  'revision',
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
]);

const DELETE_FIELDS = new Set(['action', 'id', 'revision']);
const ENABLE_FIELDS = new Set(['action', 'id', 'revision', 'enabled']);
const LIST_FIELDS = new Set(['action', 'cursor', 'limit']);
const EXACT_ALARM_FIELDS = new Set(['action']);

function invalid(message) {
  return messageError('INVALID_ARGUMENT', message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`未知参数: ${key}`);
    }
  }
}

export function assertCanonicalUuid(value, label = 'id') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw invalid(`${label} 必须是规范 UUID`);
  }
  return value;
}

export function assertPositiveRevision(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid('revision 必须是正整数');
  }
  return value;
}

function assertWellFormedRange(value, minLen, maxLen, label) {
  if (
    typeof value !== 'string' ||
    value.length < minLen ||
    value.length > maxLen ||
    !value.isWellFormed() ||
    value.trim().length === 0
  ) {
    throw invalid(`${label} 必须是 ${minLen}..${maxLen} 字符的非空白文本`);
  }
  return value;
}

export function validateScheduleTaskFields(task) {
  if (!isPlainObject(task)) throw invalid('任务数据无效');
  assertWellFormedRange(task.title, 1, 80, 'title');
  assertWellFormedRange(task.prompt, 1, 8000, 'prompt');
  if (typeof task.repeat !== 'string' || !REPEATS_SET.has(task.repeat)) {
    throw invalid('重复方式无效');
  }
  if (typeof task.time !== 'string' || !TIME_RE.test(task.time)) {
    throw invalid('时间格式无效');
  }
  if (task.alarmMode !== undefined && (typeof task.alarmMode !== 'string' || !ALARM_MODES.has(task.alarmMode))) {
    throw invalid('alarmMode 必须是 exact 或 alarmClock');
  }
  if (task.vibrate !== undefined && typeof task.vibrate !== 'boolean') {
    throw invalid('vibrate 必须是布尔值');
  }
  if (task.deleteAfterRun !== undefined && typeof task.deleteAfterRun !== 'boolean') {
    throw invalid('deleteAfterRun 必须是布尔值');
  }
  if (task.weekday !== undefined && (!Number.isInteger(task.weekday) || task.weekday < 1 || task.weekday > 7)) {
    throw invalid('weekday 必须是 1..7 的整数');
  }
  if (task.weekdays !== undefined) {
    if (!Array.isArray(task.weekdays)) throw invalid('weekdays 必须是数组');
    for (const day of task.weekdays) {
      if (!Number.isInteger(day)) throw invalid('weekdays 必须是整数数组');
    }
  }
  if (task.monthDay !== undefined && (!Number.isInteger(task.monthDay) || task.monthDay < 1 || task.monthDay > 31)) {
    throw invalid('monthDay 必须是 1..31 的整数');
  }
  try {
    ScheduleRule.fromJson(task);
  } catch (err) {
    throw invalid(err?.message || '重复规则无效');
  }
}

export function normalizeScheduleTaskInput(input) {
  if (!isPlainObject(input)) throw invalid('缺少参数');
  const action = input.action;
  if (typeof action !== 'string' || action === '') throw invalid('缺少 action');
  switch (action) {
    case 'list': {
      rejectUnknownFields(input, LIST_FIELDS);
      const out = { action: 'list' };
      if (input.cursor !== undefined && input.cursor !== null) {
        out.cursor = assertCanonicalUuid(input.cursor, 'cursor');
      }
      if (input.limit !== undefined) {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
          throw invalid('limit 必须是 1..50 的整数');
        }
        out.limit = input.limit;
      }
      return out;
    }
    case 'create': {
      rejectUnknownFields(input, CREATE_FIELDS);
      const out = { action: 'create' };
      for (const key of ['title', 'prompt', 'repeat', 'time']) {
        if (input[key] === undefined || input[key] === null) throw invalid(`缺少必要参数: ${key}`);
        out[key] = input[key];
      }
      if (input.weekday !== undefined) out.weekday = input.weekday;
      if (input.weekdays !== undefined) out.weekdays = Array.isArray(input.weekdays) ? input.weekdays.slice() : input.weekdays;
      if (input.monthDay !== undefined) out.monthDay = input.monthDay;
      if (input.alarmMode !== undefined) out.alarmMode = input.alarmMode;
      if (input.vibrate !== undefined) out.vibrate = input.vibrate;
      if (input.deleteAfterRun !== undefined) out.deleteAfterRun = input.deleteAfterRun;
      validateScheduleTaskFields(out);
      return out;
    }
    case 'update': {
      rejectUnknownFields(input, UPDATE_FIELDS);
      const out = {
        action: 'update',
        id: assertCanonicalUuid(input.id, 'id'),
        revision: assertPositiveRevision(input.revision),
      };
      for (const key of [
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
      ]) {
        if (input[key] !== undefined) {
          out[key] = Array.isArray(input[key]) ? input[key].slice() : input[key];
        }
      }
      return out;
    }
    case 'delete': {
      rejectUnknownFields(input, DELETE_FIELDS);
      return {
        action: 'delete',
        id: assertCanonicalUuid(input.id, 'id'),
        revision: assertPositiveRevision(input.revision),
      };
    }
    case 'setEnabled': {
      rejectUnknownFields(input, ENABLE_FIELDS);
      if (typeof input.enabled !== 'boolean') throw invalid('enabled 必须是布尔值');
      return {
        action: 'setEnabled',
        id: assertCanonicalUuid(input.id, 'id'),
        revision: assertPositiveRevision(input.revision),
        enabled: input.enabled,
      };
    }
    case 'requestExactAlarm': {
      rejectUnknownFields(input, EXACT_ALARM_FIELDS);
      return { action: 'requestExactAlarm' };
    }
    default:
      throw invalid(`未知操作: ${action}`);
  }
}

export function normalizeScheduleControlParams(params) {
  if (!isPlainObject(params)) throw invalid('params must be an object');
  rejectUnknownFields(params, new Set(['botId', 'input']));
  assertId(params.botId, 'botId');
  return {
    botId: params.botId,
    input: normalizeScheduleTaskInput(params.input),
  };
}
