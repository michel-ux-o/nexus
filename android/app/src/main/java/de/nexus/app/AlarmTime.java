package de.nexus.app;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.List;
import java.util.Set;

/** Calendar arithmetic shared with the standalone JVM tests (Android API 26+). */
final class AlarmTime {
    private AlarmTime() { }

    static final class Day {
        final int weekday;
        final boolean enabled;
        final int hour;
        final int minute;

        Day(int weekday, boolean enabled, int hour, int minute) {
            if (weekday < 1 || weekday > 7 || hour < 0 || hour > 23
                    || minute < 0 || minute > 59) {
                throw new IllegalArgumentException("Invalid alarm day");
            }
            this.weekday = weekday;
            this.enabled = enabled;
            this.hour = hour;
            this.minute = minute;
        }
    }

    static final class Occurrence {
        final String id;
        final long triggerMillis;

        Occurrence(String id, long triggerMillis) {
            this.id = id;
            this.triggerMillis = triggerMillis;
        }
    }

    static Occurrence next(List<Day> days, long nowMillis, ZoneId zone, Set<String> fired) {
        LocalDate today = Instant.ofEpochMilli(nowMillis).atZone(zone).toLocalDate();
        Occurrence next = null;
        for (Day day : days) {
            if (!day.enabled) continue;
            int offset = Math.floorMod(day.weekday - today.getDayOfWeek().getValue(), 7);
            LocalDate date = today.plusDays(offset);
            // Every rejected week must correspond to an already-fired occurrence.
            for (int attempt = 0; attempt <= fired.size() + 1; attempt++, date = date.plusWeeks(1)) {
                LocalDateTime local = date.atTime(LocalTime.of(day.hour, day.minute));
                // A gap moves the local time forward by the gap. An overlap uses its first
                // offset, so a repeated wall-clock time rings only once on that local date.
                long trigger = local.atZone(zone).toInstant().toEpochMilli();
                String id = "weekly:" + local;
                if (trigger <= nowMillis || fired.contains(id)) continue;
                if (next == null || trigger < next.triggerMillis) next = new Occurrence(id, trigger);
                break;
            }
        }
        return next;
    }

    static long snoozeTrigger(long nowMillis, int minutes) {
        if (minutes < 5 || minutes > 30) throw new IllegalArgumentException("Invalid snooze duration");
        return Math.addExact(nowMillis, minutes * 60_000L);
    }
}
