package de.nexus.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** Registers only the next user-visible alarm, recomputing local dates after each delivery. */
public final class AlarmScheduler {
    public static final String ACTION_ALARM = "de.nexus.app.action.ALARM";
    public static final String EXTRA_OCCURRENCE_ID = "occurrenceId";
    public static final String EXTRA_TRIGGER_MILLIS = "triggerMillis";
    private static final String TAG = "NexusAlarmScheduler";
    private static final int ALARM_REQUEST = 186;
    private static final int SHOW_REQUEST = 187;

    private AlarmScheduler() { }

    public static boolean canScheduleExactAlarms(Context context) {
        AlarmManager manager = context.getSystemService(AlarmManager.class);
        return manager != null && (Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms());
    }

    /** False means exact-alarm access or registration failed; no inexact fallback is used. */
    public static synchronized boolean reschedule(Context context) {
        // Bridge calls may arrive on a different thread from native settings/receivers.
        // Keep configuration reads and the resulting registration atomic with save().
        synchronized (AlarmStore.class) {
            return registerNext(context);
        }
    }

    private static boolean registerNext(Context context) {
        AlarmManager manager = context.getSystemService(AlarmManager.class);
        try {
            cancelRegistration(context, manager);
            AlarmStore.clearScheduled(context);
            if (!canScheduleExactAlarms(context)) return false;
            long now = System.currentTimeMillis();
            Set<String> fired = AlarmStore.fired(context);
            JSONObject config = AlarmStore.load(context);
            JSONArray source = config.optJSONArray("days");
            List<AlarmTime.Day> days = new ArrayList<>();
            for (int index = 0; source != null && index < source.length(); index++) {
                JSONObject day = source.optJSONObject(index);
                if (day != null) days.add(new AlarmTime.Day(day.optInt("weekday"), day.optBoolean("enabled"),
                        day.optInt("hour"), day.optInt("minute")));
            }
            AlarmTime.Occurrence next = AlarmTime.next(days, now, ZoneId.systemDefault(), fired);
            AlarmStore.Scheduled snooze = AlarmStore.pendingSnooze(context);
            if (snooze.id != null && (snooze.triggerMillis <= now || fired.contains(snooze.id))) {
                // Reboot/time-change recovery never turns an expired snooze into an immediate ring.
                AlarmStore.clearSnooze(context);
            } else if (snooze.id != null && (next == null || snooze.triggerMillis < next.triggerMillis)) {
                next = new AlarmTime.Occurrence(snooze.id, snooze.triggerMillis);
            }
            if (next == null) return true;
            AlarmStore.setScheduled(context, next.id, next.triggerMillis);
            Intent show = new Intent().setClassName(context, "de.nexus.app.AlarmSettingsActivity")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent showIntent = PendingIntent.getActivity(context, SHOW_REQUEST, show,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            manager.setAlarmClock(new AlarmManager.AlarmClockInfo(next.triggerMillis, showIntent),
                    operation(context, next.id, next.triggerMillis, PendingIntent.FLAG_UPDATE_CURRENT));
            return true;
        } catch (RuntimeException exception) {
            try {
                cancelRegistration(context, manager);
                AlarmStore.clearScheduled(context);
            } catch (RuntimeException cleanupException) {
                Log.e(TAG, "Cannot clear failed alarm registration", cleanupException);
            }
            Log.e(TAG, "Cannot register exact alarm", exception);
            return false;
        }
    }

    /** Cancels pending delivery/snooze; saved weekday settings are kept. */
    public static synchronized void cancel(Context context) {
        synchronized (AlarmStore.class) {
            cancelRegistration(context, context.getSystemService(AlarmManager.class));
            AlarmStore.clearScheduled(context);
            AlarmStore.clearSnooze(context);
        }
    }

    /** Idempotent while a snooze is already pending. Callers stop audio only after true. */
    public static synchronized boolean snooze(Context context) {
        synchronized (AlarmStore.class) {
            return registerSnooze(context);
        }
    }

    private static boolean registerSnooze(Context context) {
        try {
            if (!canScheduleExactAlarms(context)) return false;
            long now = System.currentTimeMillis();
            AlarmStore.Scheduled snooze = AlarmStore.pendingSnooze(context);
            boolean created = snooze.id == null || snooze.triggerMillis <= now;
            if (created) {
                long trigger = AlarmTime.snoozeTrigger(now, AlarmStore.snoozeMinutes(context));
                AlarmStore.setSnooze(context, "snooze:" + trigger, trigger);
            }
            boolean registered = reschedule(context);
            if (!registered && created) AlarmStore.clearSnooze(context);
            return registered;
        } catch (RuntimeException exception) {
            Log.e(TAG, "Cannot register snooze", exception);
            return false;
        }
    }

    /** Epoch milliseconds for the registered alarm, or zero when there is none. */
    public static synchronized long nextTriggerMillis(Context context) {
        return canScheduleExactAlarms(context) ? AlarmStore.scheduled(context).triggerMillis : 0;
    }

    static synchronized boolean claimAndScheduleNext(Context context, Intent intent) {
        boolean claimed = AlarmStore.claim(context, intent.getStringExtra(EXTRA_OCCURRENCE_ID),
                intent.getLongExtra(EXTRA_TRIGGER_MILLIS, 0), System.currentTimeMillis());
        if (claimed) reschedule(context);
        return claimed;
    }

    private static PendingIntent operation(Context context, String id, long triggerMillis, int flags) {
        Intent intent = new Intent(context, AlarmReceiver.class).setAction(ACTION_ALARM);
        if (id != null) intent.putExtra(EXTRA_OCCURRENCE_ID, id).putExtra(EXTRA_TRIGGER_MILLIS, triggerMillis);
        return PendingIntent.getBroadcast(context, ALARM_REQUEST, intent, flags | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void cancelRegistration(Context context, AlarmManager manager) {
        PendingIntent pending = operation(context, null, 0, PendingIntent.FLAG_NO_CREATE);
        if (pending != null) {
            if (manager != null) manager.cancel(pending);
            pending.cancel();
        }
    }
}
