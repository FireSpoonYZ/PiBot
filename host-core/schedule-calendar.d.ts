export const SCHEDULE_REPEATS: readonly ['once', 'daily', 'weekly', 'monthly', 'statutoryWorkday', 'statutoryHoliday'];
export type ScheduleRepeat = (typeof SCHEDULE_REPEATS)[number];

interface CalendarData {
  sourceCommit?: string;
  years: { year: number; papers: string[]; days: { date: string; isOffDay: boolean }[] }[];
}
export const CN_HOLIDAYS_DATA: Readonly<CalendarData>;

export function zonedWallTimeToEpochMs(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number;
export function resolveSystemTimeZone(): string;

export interface ScheduleCalendarDescription {
  calendarCoverage?: string;
  calendarNotice?: string;
  calendarFallback?: string;
}

export class ScheduleCalendar {
  static readonly UNSUPPORTED: string;
  static readonly EMPTY: ScheduleCalendar;
  static supports(zoneId: string): boolean;
  static parse(value: unknown): ScheduleCalendar;
  isWorkday(year: number, month: number, day: number, zoneId: string): boolean;
  describe(result: ScheduleCalendarDescription, rule: ScheduleRule, afterMs: number, nextMs: number, zoneId: string): void;
}

export function getDefaultScheduleCalendar(): ScheduleCalendar;

export class ScheduleRule {
  constructor(repeat: ScheduleRepeat, time: string, weekdaysInput: number | number[], monthDay?: number);
  static fromJson(value: unknown): ScheduleRule;
  isStatutory(): boolean;
  nextAfter(afterMs: number, zoneId?: string, calendar?: ScheduleCalendar): number;
  json(): { repeat: ScheduleRepeat; time: string; weekday: number; monthDay: number; weekdays?: number[] };
}
