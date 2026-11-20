package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.time.Instant;
import java.time.ZoneId;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class ScheduleRuleTest {
    private static final ZoneId UTC = ZoneId.of("UTC");
    private static long at(String value) { return Instant.parse(value).toEpochMilli(); }

    @Test public void dailyUsesTheNextStrictlyFutureLocalTime() {
        ScheduleRule rule = new ScheduleRule("daily", "08:00", 1, 1);
        assertEquals(at("2026-09-15T08:00:00Z"), rule.nextAfter(at("2026-09-15T07:59:59Z"), UTC));
        assertEquals(at("2026-09-16T08:00:00Z"), rule.nextAfter(at("2026-09-15T08:00:00Z"), UTC));
        assertEquals(at("2026-09-16T00:00:00Z"), rule.nextAfter(at("2026-09-15T00:00:00Z"), ZoneId.of("Asia/Shanghai")));
    }

    @Test public void weeklyHandlesWeekAndYearBoundaries() {
        ScheduleRule friday = new ScheduleRule("weekly", "18:00", 5, 1);
        assertEquals(at("2026-09-18T18:00:00Z"), friday.nextAfter(at("2026-09-15T09:00:00Z"), UTC));
        assertEquals(at("2026-09-25T18:00:00Z"), friday.nextAfter(at("2026-09-18T18:00:00Z"), UTC));
        ScheduleRule monday = new ScheduleRule("weekly", "00:00", 1, 1);
        assertEquals(at("2027-01-04T00:00:00Z"), monday.nextAfter(at("2026-12-31T23:59:59Z"), UTC));
    }

    @Test public void monthlySkipsMissingDatesAndHonorsLeapYears() {
        ScheduleRule last31 = new ScheduleRule("monthly", "20:00", 1, 31);
        assertEquals(at("2026-05-31T20:00:00Z"), last31.nextAfter(at("2026-04-01T00:00:00Z"), UTC));
        assertEquals(at("2027-01-31T20:00:00Z"), last31.nextAfter(at("2026-12-31T20:00:00Z"), UTC));
        ScheduleRule day29 = new ScheduleRule("monthly", "08:00", 1, 29);
        assertEquals(at("2027-03-29T08:00:00Z"), day29.nextAfter(at("2027-02-01T00:00:00Z"), UTC));
        assertEquals(at("2028-02-29T08:00:00Z"), day29.nextAfter(at("2028-02-01T00:00:00Z"), UTC));
    }

    @Test public void dstGapsShiftForwardAndOverlapsDoNotRunTwice() {
        ZoneId zone = ZoneId.of("America/New_York");
        ScheduleRule gap = new ScheduleRule("daily", "02:30", 1, 1);
        assertEquals(at("2026-03-08T07:30:00Z"), gap.nextAfter(at("2026-03-08T05:00:00Z"), zone));
        ScheduleRule overlap = new ScheduleRule("daily", "01:30", 1, 1);
        assertEquals(at("2026-11-01T05:30:00Z"), overlap.nextAfter(at("2026-11-01T04:00:00Z"), zone));
        assertEquals(at("2026-11-02T06:30:00Z"), overlap.nextAfter(at("2026-11-01T05:30:00Z"), zone));
    }

    @Test public void oneTimeAndMultiDayRulesHandleMidnightNextWeekAndLegacyWeekly() throws Exception {
        JSONObject legacy = new JSONObject().put("repeat", "once").put("time", "00:00")
                .put("runAt", at("2026-12-31T00:00:00Z"));
        ScheduleRule once = ScheduleRule.fromJson(legacy);
        assertFalse(once.json().has("runAt"));
        assertEquals(at("2026-09-16T00:00:00Z"), once.nextAfter(at("2026-09-15T23:59:59Z"), UTC));
        assertEquals(at("2026-09-17T00:00:00Z"), once.nextAfter(at("2026-09-16T00:00:00Z"), UTC));
        legacy.put("runAt", at("2026-01-01T00:00:00Z"));
        assertEquals(at("2026-09-16T00:00:00Z"),
                ScheduleRule.fromJson(legacy).nextAfter(at("2026-09-15T23:59:59Z"), UTC));
        JSONObject input = new JSONObject().put("repeat", "weekly").put("time", "08:00").put("weekday", 7)
                .put("runAt", at("2026-12-31T00:00:00Z"));
        assertEquals(7, ScheduleRule.fromJson(input).weekday);
        input.put("weekdays", new JSONArray().put(5).put(1).put(3));
        ScheduleRule multi = ScheduleRule.fromJson(input);
        assertEquals("[1,3,5]", multi.json().getJSONArray("weekdays").toString());
        assertEquals(at("2026-09-16T08:00:00Z"), multi.nextAfter(at("2026-09-15T20:00:00Z"), UTC));
        assertEquals(at("2026-09-21T08:00:00Z"), multi.nextAfter(at("2026-09-18T08:00:00Z"), UTC));
        input.put("weekdays", new JSONArray().put(1).put(2).put(3).put(4).put(5).put(6).put(7));
        assertEquals("daily", ScheduleRule.fromJson(input).repeat);
        for (JSONArray invalid : new JSONArray[]{new JSONArray(), new JSONArray().put(1).put(1),
                new JSONArray().put(0), new JSONArray().put(8), new JSONArray().put(2.5), new JSONArray().put("1")}) {
            input.put("weekdays", invalid);
            assertThrows(IllegalArgumentException.class, () -> ScheduleRule.fromJson(input));
        }
        input.put("weekdays", "bad");
        assertThrows(IllegalArgumentException.class, () -> ScheduleRule.fromJson(input));
    }

    @Test public void datedOneTimeRuleKeepsTheRequestedLocalDateAndRejectsExpiredDates() throws Exception {
        ZoneId shanghai = ZoneId.of("Asia/Shanghai");
        JSONObject input = new JSONObject().put("repeat", "once").put("time", "20:00").put("date", "2028-02-29");
        ScheduleRule rule = ScheduleRule.fromJson(input);
        long due = at("2028-02-29T12:00:00Z");
        assertEquals("2028-02-29", rule.json().getString("date"));
        assertEquals(due, rule.nextAfter(at("2026-12-31T00:00:00Z"), shanghai));
        assertThrows(IllegalArgumentException.class, () -> rule.nextAfter(due, shanghai));
        input.put("date", "2027-02-29");
        assertThrows(IllegalArgumentException.class, () -> ScheduleRule.fromJson(input));
        input.put("repeat", "daily").put("date", "2028-02-29");
        assertThrows(IllegalArgumentException.class, () -> ScheduleRule.fromJson(input));
    }

    @Test public void chinaRulesIncludeMakeupShiftsAndAllDaysOffWithoutChangingFixedWeekly() throws Exception {
        ScheduleCalendar calendar = ScheduleCalendar.load(RuntimeEnvironment.getApplication());
        ZoneId china = ZoneId.of("Asia/Shanghai");
        ScheduleRule work = new ScheduleRule("statutoryWorkday", "08:00", 1, 1);
        ScheduleRule off = new ScheduleRule("statutoryHoliday", "08:00", 1, 1);
        assertEquals(at("2026-02-14T00:00:00Z"), work.nextAfter(at("2026-02-13T23:59:59Z"), china, calendar));
        assertEquals(at("2026-02-24T00:00:00Z"), work.nextAfter(at("2026-02-14T00:00:00Z"), china, calendar));
        assertEquals(at("2026-02-15T00:00:00Z"), off.nextAfter(at("2026-02-13T23:59:59Z"), china, calendar));
        assertEquals(at("2026-02-28T00:00:00Z"), work.nextAfter(at("2026-02-27T00:00:00Z"), china, calendar));
        assertEquals(at("2026-09-20T00:00:00Z"), work.nextAfter(at("2026-09-19T00:00:00Z"), china, calendar));
        assertEquals(at("2026-09-26T00:00:00Z"), off.nextAfter(at("2026-09-25T00:00:00Z"), china, calendar));
        assertEquals(at("2026-10-08T00:00:00Z"), work.nextAfter(at("2026-10-01T00:00:00Z"), china, calendar));
        assertEquals(at("2026-10-10T00:00:00Z"), work.nextAfter(at("2026-10-09T00:00:00Z"), china, calendar));
        assertEquals(at("2026-10-11T00:00:00Z"), off.nextAfter(at("2026-10-09T00:00:00Z"), china, calendar));
        ScheduleRule fixed = ScheduleRule.fromJson(new JSONObject().put("repeat", "weekly").put("time", "08:00")
                .put("weekdays", new JSONArray("[1,2,3,4,5]")));
        assertEquals(at("2026-10-02T00:00:00Z"), fixed.nextAfter(at("2026-10-01T00:00:00Z"), china, calendar));
        assertFalse(work.json().has("weekdays"));
        assertEquals("statutoryWorkday", ScheduleRule.fromJson(work.json()).repeat);
    }

    @Test public void calendarFallbackIsExplicitForUnknownYearsUnavailableDataAndNonMainlandZones() throws Exception {
        ScheduleCalendar calendar = ScheduleCalendar.load(RuntimeEnvironment.getApplication());
        ScheduleRule work = new ScheduleRule("statutoryWorkday", "08:00", 1, 1);
        ScheduleRule off = new ScheduleRule("statutoryHoliday", "08:00", 1, 1);
        ZoneId china = ZoneId.of("Asia/Shanghai");
        long after = at("2026-12-31T00:00:00Z");
        long next = work.nextAfter(after, china, calendar);
        assertEquals(at("2027-01-01T00:00:00Z"), next);
        JSONObject info = new JSONObject();
        calendar.describe(info, work, after, next, china);
        assertTrue(info.getString("calendarCoverage").contains("2026"));
        assertTrue(info.getString("calendarNotice").contains("2027"));
        assertEquals("暂按周一至周五执行", info.getString("calendarFallback"));
        assertEquals(at("2027-01-02T00:00:00Z"), off.nextAfter(after, china, calendar));
        assertEquals(at("2026-10-02T00:00:00Z"), work.nextAfter(at("2026-10-01T00:00:00Z"), china, ScheduleCalendar.EMPTY));
        info = new JSONObject();
        ScheduleCalendar.EMPTY.describe(info, work, after, next, china);
        assertTrue(info.has("calendarNotice"));
        assertFalse(info.has("calendarCoverage"));
        for (String id : new String[]{"Asia/Singapore", "Asia/Hong_Kong", "Asia/Macau", "Asia/Taipei", "UTC", "America/New_York"}) {
            ZoneId zone = ZoneId.of(id);
            long start = java.time.LocalDate.of(2026, 10, 1).atTime(8, 0).atZone(zone).toInstant().toEpochMilli();
            assertEquals(java.time.LocalDate.of(2026, 10, 2).atTime(8, 0).atZone(zone).toInstant().toEpochMilli(),
                    work.nextAfter(start, zone, calendar));
            info = new JSONObject();
            calendar.describe(info, work, start, work.nextAfter(start, zone, calendar), zone);
            assertEquals(ScheduleCalendar.UNSUPPORTED, info.getString("calendarNotice"));
            assertFalse(info.has("calendarCoverage"));
        }
        for (String id : new String[]{"Asia/Shanghai", "Asia/Urumqi", "Asia/Chongqing", "Asia/Harbin", "Asia/Kashgar", "PRC"}) {
            ZoneId zone = ZoneId.of(id);
            assertTrue(calendar.isWorkday(java.time.LocalDate.of(2026, 9, 20), zone));
            assertFalse(calendar.isWorkday(java.time.LocalDate.of(2026, 10, 2), zone));
        }
    }

    @Test public void snapshotBoundaryRejectsInvalidDatesEmptyCoverageAndConflictsAndRetainsAdjacentDates() throws Exception {
        JSONObject day = new JSONObject().put("date", "2026-12-31").put("isOffDay", true);
        JSONObject annual = new JSONObject().put("year", 2026).put("papers", new JSONArray().put("https://www.gov.cn/notice"))
                .put("days", new JSONArray().put(day));
        JSONObject data = new JSONObject().put("sourceCommit", "dcecbce230a57639cc8967ec9e2465e744880fd8")
                .put("years", new JSONArray().put(annual));
        assertFalse(ScheduleCalendar.parse(data).isWorkday(java.time.LocalDate.of(2026, 12, 31), ZoneId.of("Asia/Shanghai")));
        annual.put("year", 2027); // Next year's announcement can adjust the preceding December.
        assertFalse(ScheduleCalendar.parse(data).isWorkday(java.time.LocalDate.of(2026, 12, 31), ZoneId.of("Asia/Shanghai")));
        JSONObject info = new JSONObject();
        ScheduleRule work = new ScheduleRule("statutoryWorkday", "08:00", 1, 1);
        ScheduleCalendar.parse(data).describe(info, work, at("2026-12-30T00:00:00Z"), at("2027-01-01T00:00:00Z"), ZoneId.of("Asia/Shanghai"));
        assertTrue(info.getString("calendarNotice").contains("2026"));
        data.getJSONArray("years").put(new JSONObject().put("year", 2026)
                .put("papers", new JSONArray().put("https://www.gov.cn/notice"))
                .put("days", new JSONArray().put(new JSONObject().put("date", "2026-01-01").put("isOffDay", true))));
        assertFalse(ScheduleCalendar.parse(data).isWorkday(java.time.LocalDate.of(2026, 12, 31), ZoneId.of("Asia/Shanghai")));
        day.put("date", "2026-02-30");
        assertThrows(Exception.class, () -> ScheduleCalendar.parse(data));
        day.put("date", "2026-12-31").put("isOffDay", "true");
        assertThrows(Exception.class, () -> ScheduleCalendar.parse(data));
        day.put("isOffDay", true);
        annual.getJSONArray("days").put(new JSONObject(day.toString()).put("isOffDay", false));
        assertThrows(Exception.class, () -> ScheduleCalendar.parse(data));
        annual.put("days", new JSONArray());
        assertThrows(Exception.class, () -> ScheduleCalendar.parse(data));
        annual.put("days", new JSONArray().put(day)).put("papers", new JSONArray());
        assertThrows(Exception.class, () -> ScheduleCalendar.parse(data));
    }

    @Test public void rejectsUnsupportedOrMalformedRules() {
        for (String repeat : new String[] {"workday", "weekend", "", "DAILY"})
            assertThrows(IllegalArgumentException.class, () -> new ScheduleRule(repeat, "08:00", 1, 1));
        for (String time : new String[] {"24:00", "8:00", "12:60", "12:00:00", "", "-1:00"})
            assertThrows(IllegalArgumentException.class, () -> new ScheduleRule("daily", time, 1, 1));
        assertThrows(IllegalArgumentException.class, () -> new ScheduleRule("weekly", "08:00", 0, 1));
        assertThrows(IllegalArgumentException.class, () -> new ScheduleRule("monthly", "08:00", 1, 32));
    }
}
