// host-core/schedule-calendar.js
// Pure JS wall-clock recurrence and statutory holiday calendar matching
// ScheduleRule.java and ScheduleCalendar.java. No node:* or external imports so
// both Host and client bundles can share rule/calendar validation.

export const SCHEDULE_REPEATS = Object.freeze([
  'once',
  'daily',
  'weekly',
  'monthly',
  'statutoryWorkday',
  'statutoryHoliday',
]);

const REPEATS_SET = new Set(SCHEDULE_REPEATS);
const TIME_RE = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const SHA1_RE = /^[a-f0-9]{40}$/;

const CHINA_ZONES = new Set([
  'Asia/Shanghai',
  'Asia/Urumqi',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Kashgar',
  'PRC',
]);

export const CN_HOLIDAYS_DATA = Object.freeze({
  sourceCommit: 'dcecbce230a57639cc8967ec9e2465e744880fd8',
  years: [
    {
      year: 2026,
      papers: [
        'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
      ],
      days: [
        { date: '2026-01-01', isOffDay: true },
        { date: '2026-01-02', isOffDay: true },
        { date: '2026-01-03', isOffDay: true },
        { date: '2026-01-04', isOffDay: false },
        { date: '2026-02-14', isOffDay: false },
        { date: '2026-02-15', isOffDay: true },
        { date: '2026-02-16', isOffDay: true },
        { date: '2026-02-17', isOffDay: true },
        { date: '2026-02-18', isOffDay: true },
        { date: '2026-02-19', isOffDay: true },
        { date: '2026-02-20', isOffDay: true },
        { date: '2026-02-21', isOffDay: true },
        { date: '2026-02-22', isOffDay: true },
        { date: '2026-02-23', isOffDay: true },
        { date: '2026-02-28', isOffDay: false },
        { date: '2026-04-04', isOffDay: true },
        { date: '2026-04-05', isOffDay: true },
        { date: '2026-04-06', isOffDay: true },
        { date: '2026-05-01', isOffDay: true },
        { date: '2026-05-02', isOffDay: true },
        { date: '2026-05-03', isOffDay: true },
        { date: '2026-05-04', isOffDay: true },
        { date: '2026-05-05', isOffDay: true },
        { date: '2026-05-09', isOffDay: false },
        { date: '2026-06-19', isOffDay: true },
        { date: '2026-06-20', isOffDay: true },
        { date: '2026-06-21', isOffDay: true },
        { date: '2026-09-20', isOffDay: false },
        { date: '2026-09-25', isOffDay: true },
        { date: '2026-09-26', isOffDay: true },
        { date: '2026-09-27', isOffDay: true },
        { date: '2026-10-01', isOffDay: true },
        { date: '2026-10-02', isOffDay: true },
        { date: '2026-10-03', isOffDay: true },
        { date: '2026-10-04', isOffDay: true },
        { date: '2026-10-05', isOffDay: true },
        { date: '2026-10-06', isOffDay: true },
        { date: '2026-10-07', isOffDay: true },
        { date: '2026-10-10', isOffDay: false },
      ],
    },
  ],
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidLocalDate(year, month, day) {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12 &&
    Number.isInteger(day) &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

function formatDateKey(year, month, day) {
  return (
    String(year).padStart(4, '0') +
    '-' +
    String(month).padStart(2, '0') +
    '-' +
    String(day).padStart(2, '0')
  );
}

function isoWeekday(year, month, day) {
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

function nextLocalDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

const formatterCache = new Map();

function getZoneFormatter(timeZone) {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function zonedDatePartsAt(epochMs, timeZone) {
  const parts = getZoneFormatter(timeZone).formatToParts(new Date(epochMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const p of parts) {
    if (p.type === 'year') year = Number(p.value);
    else if (p.type === 'month') month = Number(p.value);
    else if (p.type === 'day') day = Number(p.value);
    else if (p.type === 'hour') hour = Number(p.value);
    else if (p.type === 'minute') minute = Number(p.value);
    else if (p.type === 'second') second = Number(p.value);
  }
  return { year, month, day, hour, minute, second };
}

function offsetAt(epochMs, timeZone) {
  const p = zonedDatePartsAt(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - epochMs;
}

/**
 * Convert a local date (year, month 1..12, day 1..31) and time (hour, minute) in
 * timeZone to epoch milliseconds, matching java.time ZonedDateTime semantics:
 * - Shifts DST gaps forward by the gap length
 * - Chooses the earlier (first) offset in a DST overlap
 */
export function zonedWallTimeToEpochMs(year, month, day, hour, minute, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offBefore = offsetAt(utcGuess - 6 * 3600_000, timeZone);
  const offAfter = offsetAt(utcGuess + 6 * 3600_000, timeZone);
  const candidateEarlier = utcGuess - offBefore;
  if (offBefore === offAfter) return candidateEarlier;
  if (offsetAt(candidateEarlier, timeZone) === offBefore) {
    return candidateEarlier;
  }
  const candidateLater = utcGuess - offAfter;
  if (offsetAt(candidateLater, timeZone) === offAfter) {
    return candidateLater;
  }
  return candidateEarlier;
}

export function resolveSystemTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof tz === 'string' && tz.trim() !== '') return tz;
  } catch {
    /* ignore */
  }
  return 'UTC';
}

export class ScheduleCalendar {
  static UNSUPPORTED = '所在国家或地区暂不支持法定节假日查询';
  static EMPTY = new ScheduleCalendar();

  constructor() {
    this.years = new Set();
    this.offDays = new Map();
  }

  static supports(zoneId) {
    return CHINA_ZONES.has(zoneId);
  }

  static parse(value) {
    if (!isPlainObject(value)) throw new Error('Invalid calendar data');
    if (
      value.sourceCommit !== undefined &&
      (typeof value.sourceCommit !== 'string' || !SHA1_RE.test(value.sourceCommit))
    ) {
      throw new Error('Invalid calendar source commit');
    }
    if (!Array.isArray(value.years) || value.years.length === 0) {
      throw new Error('Missing verified coverage');
    }
    const calendar = new ScheduleCalendar();
    const sortedYears = [];
    for (const rawEntry of value.years) {
      if (!isPlainObject(rawEntry)) throw new Error('Invalid calendar entry');
      const year = rawEntry.year;
      if (!Number.isInteger(year) || year < 2007 || year > 2100 || calendar.years.has(year)) {
        throw new Error('Invalid calendar coverage');
      }
      calendar.years.add(year);
      sortedYears.push(year);
      const sourceCommit = rawEntry.sourceCommit !== undefined ? rawEntry.sourceCommit : value.sourceCommit;
      if (sourceCommit !== undefined) {
        if (typeof sourceCommit !== 'string' || !SHA1_RE.test(sourceCommit)) {
          throw new Error('Invalid calendar source commit');
        }
      } else if (
        rawEntry.sourceUrl !== `https://api.github.com/repos/NateScarlet/holiday-cn/contents/${year}.json?ref=master` ||
        typeof rawEntry.sourceBlobSha !== 'string' ||
        !SHA1_RE.test(rawEntry.sourceBlobSha) ||
        typeof rawEntry.fetchedAt !== 'number'
      ) {
        throw new Error('Invalid calendar download provenance');
      }
      if (!Array.isArray(rawEntry.papers) || rawEntry.papers.length === 0) {
        throw new Error('Unpublished calendar');
      }
      for (const paper of rawEntry.papers) {
        if (typeof paper !== 'string' || !paper.startsWith('https://www.gov.cn/')) {
          throw new Error('Missing official calendar source');
        }
      }
      if (!Array.isArray(rawEntry.days) || rawEntry.days.length === 0) {
        throw new Error('Empty annual calendar');
      }
      const seen = new Set();
      for (const day of rawEntry.days) {
        if (!isPlainObject(day) || typeof day.date !== 'string') {
          throw new Error('Invalid calendar day');
        }
        const m = DATE_RE.exec(day.date);
        if (!m) throw new Error('Invalid calendar date');
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        if (!isValidLocalDate(y, mo, d)) throw new Error('Invalid calendar date');
        if (typeof day.isOffDay !== 'boolean' || Math.abs(y - year) > 1 || seen.has(day.date)) {
          throw new Error('Invalid calendar day');
        }
        seen.add(day.date);
        const previous = calendar.offDays.get(day.date);
        if (previous !== undefined && previous !== day.isOffDay) {
          throw new Error('Conflicting calendar day');
        }
        calendar.offDays.set(day.date, day.isOffDay);
      }
    }
    sortedYears.sort((a, b) => a - b);
    calendar.years = new Set(sortedYears);
    return calendar;
  }

  isWorkday(year, month, day, zoneId) {
    if (CHINA_ZONES.has(zoneId)) {
      const key = formatDateKey(year, month, day);
      const off = this.offDays.get(key);
      if (off !== undefined) return !off;
    }
    return isoWeekday(year, month, day) <= 5;
  }

  describe(result, rule, afterMs, nextMs, zoneId) {
    if (!rule.isStatutory()) return;
    const fallback = rule.repeat === 'statutoryWorkday' ? '周一至周五' : '周六日';
    result.calendarFallback = `暂按${fallback}执行`;
    if (!CHINA_ZONES.has(zoneId)) {
      result.calendarNotice = ScheduleCalendar.UNSUPPORTED;
      return;
    }
    if (this.years.size > 0) {
      result.calendarCoverage = `中国大陆 · ${[...this.years].join(', ')} 年节假日安排`;
    }
    const firstYear = zonedDatePartsAt(afterMs, zoneId).year;
    const lastYear = zonedDatePartsAt(nextMs, zoneId).year;
    for (let year = firstYear; year <= lastYear; year += 1) {
      if (!this.years.has(year)) {
        result.calendarNotice = `${year} 年法定节假日数据暂未公布或未更新`;
        return;
      }
    }
    delete result.calendarFallback;
  }
}

let defaultCalendarCached = null;
export function getDefaultScheduleCalendar() {
  if (!defaultCalendarCached) {
    try {
      defaultCalendarCached = ScheduleCalendar.parse(CN_HOLIDAYS_DATA);
    } catch {
      defaultCalendarCached = ScheduleCalendar.EMPTY;
    }
  }
  return defaultCalendarCached;
}

export class ScheduleRule {
  constructor(repeat, time, weekdaysInput, monthDay = 1) {
    if (typeof repeat !== 'string' || !REPEATS_SET.has(repeat)) {
      throw new Error('请选择有效的重复方式');
    }
    const rawDays = Array.isArray(weekdaysInput) ? weekdaysInput.slice() : [weekdaysInput];
    if (rawDays.length === 0 || rawDays.length > 7) {
      throw new Error('请至少选择一个执行日');
    }
    for (const d of rawDays) {
      if (!Number.isInteger(d) || d < 1 || d > 7) {
        throw new Error('执行日需为不重复的周一至周日');
      }
    }
    rawDays.sort((a, b) => a - b);
    for (let i = 1; i < rawDays.length; i += 1) {
      if (rawDays[i] === rawDays[i - 1]) {
        throw new Error('执行日需为不重复的周一至周日');
      }
    }
    if (typeof time !== 'string' || !TIME_RE.test(time)) {
      throw new Error('请选择有效的执行时间');
    }
    if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) {
      throw new Error('请选择 1 至 31 日');
    }
    const [hourStr, minuteStr] = time.split(':');
    this.repeat = repeat === 'weekly' && rawDays.length === 7 ? 'daily' : repeat;
    this.weekdays = rawDays;
    this.weekday = rawDays[0];
    this.time = time;
    this.hour = Number(hourStr);
    this.minute = Number(minuteStr);
    this.monthDay = monthDay;
  }

  static fromJson(value) {
    if (!isPlainObject(value)) throw new Error('参数无效');
    if (typeof value.repeat !== 'string') throw new Error('repeat 必须是文本');
    if (typeof value.time !== 'string') throw new Error('time 必须是文本');
    const repeat = value.repeat;
    const time = value.time;
    let days = [1];
    if (repeat === 'weekly') {
      if (value.weekdays !== undefined) {
        if (!Array.isArray(value.weekdays)) throw new Error('weekdays 必须是数组');
        if (value.weekdays.length === 0 || value.weekdays.length > 7) {
          throw new Error('请至少选择一个执行日，最多七个');
        }
        days = value.weekdays.map((d) => {
          if (!Number.isInteger(d)) throw new Error('执行日必须是整数');
          return d;
        });
      } else {
        if (!Number.isInteger(value.weekday)) throw new Error('weekday 必须是整数');
        days = [value.weekday];
      }
    }
    let monthDay = 1;
    if (repeat === 'monthly') {
      if (!Number.isInteger(value.monthDay)) throw new Error('monthDay 必须是整数');
      monthDay = value.monthDay;
    }
    return new ScheduleRule(repeat, time, days, monthDay);
  }

  isStatutory() {
    return this.repeat === 'statutoryWorkday' || this.repeat === 'statutoryHoliday';
  }

  nextAfter(afterMs, zoneId = 'UTC', calendar = ScheduleCalendar.EMPTY) {
    const startParts = zonedDatePartsAt(afterMs, zoneId);
    let cur = { year: startParts.year, month: startParts.month, day: startParts.day };
    for (;;) {
      let matches = true;
      if (this.repeat === 'weekly') {
        const dow = isoWeekday(cur.year, cur.month, cur.day);
        if (!this.weekdays.includes(dow)) matches = false;
      } else if (this.repeat === 'monthly') {
        if (cur.day !== this.monthDay) matches = false;
      } else if (this.isStatutory()) {
        const workday = calendar.isWorkday(cur.year, cur.month, cur.day, zoneId);
        if (workday !== (this.repeat === 'statutoryWorkday')) matches = false;
      }
      if (matches) {
        const candidate = zonedWallTimeToEpochMs(
          cur.year,
          cur.month,
          cur.day,
          this.hour,
          this.minute,
          zoneId,
        );
        if (candidate > afterMs) return candidate;
      }
      cur = nextLocalDate(cur.year, cur.month, cur.day);
    }
  }

  json() {
    const out = {
      repeat: this.repeat,
      time: this.time,
      weekday: this.weekday,
      monthDay: this.monthDay,
    };
    if (this.repeat === 'weekly') {
      out.weekdays = this.weekdays.slice();
    }
    return out;
  }
}
