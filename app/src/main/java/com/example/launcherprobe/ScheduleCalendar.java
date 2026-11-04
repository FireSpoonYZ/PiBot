package com.example.launcherprobe;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/** Validated holiday data used by Host schedules. */
final class ScheduleCalendar {
    static final String UNSUPPORTED = "所在国家或地区暂不支持法定节假日查询";
    static final ScheduleCalendar EMPTY = new ScheduleCalendar();
    private static final Set<String> CHINA_ZONES = Set.of("Asia/Shanghai", "Asia/Urumqi",
            "Asia/Chongqing", "Asia/Harbin", "Asia/Kashgar", "PRC");
    private final Set<Integer> years = new TreeSet<>();
    private final Map<LocalDate, Boolean> offDays = new HashMap<>();

    static boolean supports(ZoneId zone) { return CHINA_ZONES.contains(zone.getId()); }

    static ScheduleCalendar load(Context context) {
        try (java.io.InputStream input = context.getAssets().open("cn-holidays.json")) {
            return parse(new JSONObject(new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8)));
        } catch (Exception failure) {
            return EMPTY;
        }
    }

    static ScheduleCalendar parse(JSONObject value) throws Exception {
        if (value.has("sourceCommit") && !ScheduleRule.text(value, "sourceCommit").matches("[a-f0-9]{40}"))
            throw new IllegalArgumentException("Invalid calendar source commit");
        ScheduleCalendar calendar = new ScheduleCalendar();
        JSONArray annual = value.getJSONArray("years");
        if (annual.length() == 0) throw new IllegalArgumentException("Missing verified coverage");
        for (int i = 0; i < annual.length(); i++) {
            JSONObject entry = annual.getJSONObject(i);
            int year = ScheduleRule.integer(entry, "year");
            if (year < 2007 || year > 2100 || !calendar.years.add(year))
                throw new IllegalArgumentException("Invalid calendar coverage");
            entry = new JSONObject(entry.toString());
            if (value.has("sourceCommit")) entry.put("sourceCommit", value.getString("sourceCommit"));
            if (entry.has("sourceCommit")) {
                if (!ScheduleRule.text(entry, "sourceCommit").matches("[a-f0-9]{40}"))
                    throw new IllegalArgumentException("Invalid calendar source commit");
            } else if (!("https://api.github.com/repos/NateScarlet/holiday-cn/contents/" + year + ".json?ref=master").equals(ScheduleRule.text(entry, "sourceUrl"))
                    || !ScheduleRule.text(entry, "sourceBlobSha").matches("[a-f0-9]{40}")
                    || !(entry.opt("fetchedAt") instanceof Number)) {
                throw new IllegalArgumentException("Invalid calendar download provenance");
            }
            JSONArray papers = entry.getJSONArray("papers");
            if (papers.length() == 0) throw new IllegalArgumentException("Unpublished calendar");
            for (int j = 0; j < papers.length(); j++) {
                Object paper = papers.get(j);
                if (!(paper instanceof String) || !((String) paper).startsWith("https://www.gov.cn/"))
                    throw new IllegalArgumentException("Missing official calendar source");
            }
            JSONArray days = entry.getJSONArray("days");
            if (days.length() == 0) throw new IllegalArgumentException("Empty annual calendar");
            Set<LocalDate> seen = new HashSet<>();
            for (int j = 0; j < days.length(); j++) {
                JSONObject day = days.getJSONObject(j);
                String date = ScheduleRule.text(day, "date");
                if (!date.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}"))
                    throw new IllegalArgumentException("Invalid calendar date");
                LocalDate local = LocalDate.parse(date);
                Object off = day.get("isOffDay");
                if (!(off instanceof Boolean) || Math.abs(local.getYear() - year) > 1 || !seen.add(local))
                    throw new IllegalArgumentException("Invalid calendar day");
                Boolean previous = calendar.offDays.put(local, (Boolean) off);
                if (previous != null && !previous.equals(off))
                    throw new IllegalArgumentException("Conflicting calendar day");
            }
        }
        return calendar;
    }

    boolean isWorkday(LocalDate day, ZoneId zone) {
        if (CHINA_ZONES.contains(zone.getId())) {
            Boolean off = offDays.get(day);
            if (off != null) return !off;
        }
        return day.getDayOfWeek().getValue() <= 5;
    }

    /** Notices describe every year searched, not just the year of the selected occurrence. */
    void describe(JSONObject result, ScheduleRule rule, long after, long next, ZoneId zone) throws Exception {
        if (!rule.isStatutory()) return;
        String fallback = "statutoryWorkday".equals(rule.repeat) ? "周一至周五" : "周六日";
        result.put("calendarFallback", "暂按" + fallback + "执行");
        if (!CHINA_ZONES.contains(zone.getId())) {
            result.put("calendarNotice", UNSUPPORTED);
            return;
        }
        if (!years.isEmpty()) {
            String coverage = years.toString().replace("[", "").replace("]", "");
            result.put("calendarCoverage", "中国大陆 · " + coverage + " 年节假日安排");
        }
        int first = Instant.ofEpochMilli(after).atZone(zone).getYear();
        int last = Instant.ofEpochMilli(next).atZone(zone).getYear();
        for (int year = first; year <= last; year++) {
            if (!years.contains(year)) {
                result.put("calendarNotice", year + " 年法定节假日数据暂未公布或未更新");
                return;
            }
        }
        result.remove("calendarFallback");
    }
}
