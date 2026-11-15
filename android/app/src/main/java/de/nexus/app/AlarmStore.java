package de.nexus.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.LinkedHashSet;
import java.util.Set;

/** Device-local alarm configuration. This data is deliberately outside the web workspace. */
public final class AlarmStore {
    private static final String TAG = "NexusAlarmStore";
    private static final String PREFERENCES = "nexus_native_alarm";
    private static final String CONFIG = "config";
    private static final String FIRED = "fired_occurrences";
    private static final String SCHEDULED_ID = "scheduled_id";
    private static final String SCHEDULED_AT = "scheduled_at";
    private static final String SNOOZE_ID = "snooze_id";
    private static final String SNOOZE_AT = "snooze_at";
    private static final int MAX_FIRED = 64;

    private AlarmStore() { }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    /** Returns a fresh canonical object; weekdays are ISO 1 (Monday) through 7 (Sunday). */
    public static synchronized JSONObject load(Context context) {
        String value = preferences(context).getString(CONFIG, null);
        if (value != null) {
            try {
                return validate(context, new JSONObject(value));
            } catch (JSONException | IllegalArgumentException exception) {
                Log.w(TAG, "Invalid saved alarm configuration; using disabled defaults", exception);
            }
        }
        return defaults();
    }

    /** Saves the full configuration or throws. Call reschedule after a successful save. */
    public static synchronized JSONObject save(Context context, JSONObject input) {
        JSONObject config = validate(context, input);
        // Invalidate the old occurrence before returning: a concurrently delivered old
        // PendingIntent cannot ring with settings that have just been changed.
        commit(preferences(context).edit().putString(CONFIG, config.toString())
                .remove(SCHEDULED_ID).remove(SCHEDULED_AT).remove(SNOOZE_ID).remove(SNOOZE_AT));
        return config;
    }

    public static String soundPath(Context context) {
        JSONObject config = load(context);
        return config.isNull("soundPath") ? null : config.optString("soundPath", null);
    }

    public static int snoozeMinutes(Context context) {
        return load(context).optInt("snoozeMinutes", 10);
    }

    private static JSONObject defaults() {
        try {
            JSONArray days = new JSONArray();
            for (int weekday = 1; weekday <= 7; weekday++) {
                days.put(new JSONObject().put("weekday", weekday).put("enabled", false)
                        .put("hour", 7).put("minute", 0));
            }
            return new JSONObject().put("days", days).put("snoozeMinutes", 10)
                    .put("soundPath", JSONObject.NULL).put("soundName", JSONObject.NULL);
        } catch (JSONException exception) {
            throw new IllegalStateException("Cannot construct alarm defaults", exception);
        }
    }

    private static JSONObject validate(Context context, JSONObject input) {
        if (input == null) throw new IllegalArgumentException("Alarm configuration is missing");
        try {
            JSONArray source = input.optJSONArray("days");
            if (source == null || source.length() != 7) {
                throw new IllegalArgumentException("Exactly seven alarm weekdays are required");
            }
            JSONObject[] ordered = new JSONObject[7];
            for (int index = 0; index < source.length(); index++) {
                JSONObject day = source.getJSONObject(index);
                int weekday = integer(day, "weekday", 1, 7);
                if (ordered[weekday - 1] != null) throw new IllegalArgumentException("Duplicate weekday");
                Object enabled = day.get("enabled");
                if (!(enabled instanceof Boolean)) throw new IllegalArgumentException("Invalid enabled flag");
                ordered[weekday - 1] = new JSONObject().put("weekday", weekday)
                        .put("enabled", enabled).put("hour", integer(day, "hour", 0, 23))
                        .put("minute", integer(day, "minute", 0, 59));
            }
            JSONArray days = new JSONArray();
            for (JSONObject day : ordered) days.put(day);
            int snooze = input.has("snoozeMinutes") ? integer(input, "snoozeMinutes", 5, 30) : 10;
            String path = nullableString(input, "soundPath", 4096);
            String name = nullableString(input, "soundName", 180);
            if (path != null) {
                File directory = context.getFilesDir().getCanonicalFile();
                File sound = new File(path).getCanonicalFile();
                if (!sound.getPath().startsWith(directory.getPath() + File.separator)) {
                    throw new IllegalArgumentException("Alarm sound must be in private app storage");
                }
                path = sound.getPath();
            } else {
                name = null;
            }
            return new JSONObject().put("days", days).put("snoozeMinutes", snooze)
                    .put("soundPath", path == null ? JSONObject.NULL : path)
                    .put("soundName", name == null ? JSONObject.NULL : name);
        } catch (JSONException | IOException exception) {
            throw new IllegalArgumentException("Invalid alarm configuration", exception);
        }
    }

    private static int integer(JSONObject input, String key, int minimum, int maximum) throws JSONException {
        Object value = input.get(key);
        if (!(value instanceof Number)) throw new IllegalArgumentException("Invalid " + key);
        double number = ((Number) value).doubleValue();
        if (number < minimum || number > maximum || number != Math.rint(number)) {
            throw new IllegalArgumentException("Invalid " + key);
        }
        return ((Number) value).intValue();
    }

    private static String nullableString(JSONObject input, String key, int maxLength) throws JSONException {
        if (!input.has(key) || input.isNull(key)) return null;
        Object value = input.get(key);
        if (!(value instanceof String) || ((String) value).isEmpty() || ((String) value).length() > maxLength) {
            throw new IllegalArgumentException("Invalid " + key);
        }
        return (String) value;
    }

    static final class Scheduled {
        final String id;
        final long triggerMillis;

        Scheduled(String id, long triggerMillis) {
            this.id = id;
            this.triggerMillis = triggerMillis;
        }
    }

    static synchronized Scheduled scheduled(Context context) {
        SharedPreferences preferences = preferences(context);
        return new Scheduled(preferences.getString(SCHEDULED_ID, null), preferences.getLong(SCHEDULED_AT, 0));
    }

    static synchronized Scheduled pendingSnooze(Context context) {
        SharedPreferences preferences = preferences(context);
        return new Scheduled(preferences.getString(SNOOZE_ID, null), preferences.getLong(SNOOZE_AT, 0));
    }

    static synchronized void setScheduled(Context context, String id, long triggerMillis) {
        commit(preferences(context).edit().putString(SCHEDULED_ID, id).putLong(SCHEDULED_AT, triggerMillis));
    }

    static synchronized void clearScheduled(Context context) {
        commit(preferences(context).edit().remove(SCHEDULED_ID).remove(SCHEDULED_AT));
    }

    static synchronized void setSnooze(Context context, String id, long triggerMillis) {
        commit(preferences(context).edit().putString(SNOOZE_ID, id).putLong(SNOOZE_AT, triggerMillis));
    }

    static synchronized void clearSnooze(Context context) {
        commit(preferences(context).edit().remove(SNOOZE_ID).remove(SNOOZE_AT));
    }

    static synchronized Set<String> fired(Context context) {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        try {
            JSONArray ids = new JSONArray(preferences(context).getString(FIRED, "[]"));
            for (int index = 0; index < ids.length(); index++) result.add(ids.getString(index));
        } catch (JSONException exception) {
            Log.w(TAG, "Invalid fired occurrence history", exception);
        }
        return result;
    }

    /** Persist the claim before playback, including when the receiver is delivered twice. */
    static synchronized boolean claim(Context context, String id, long triggerMillis, long nowMillis) {
        Scheduled scheduled = scheduled(context);
        if (id == null || !id.equals(scheduled.id) || triggerMillis != scheduled.triggerMillis
                || triggerMillis <= 0 || triggerMillis > nowMillis) return false;
        Set<String> history = fired(context);
        if (!history.add(id)) return false;
        while (history.size() > MAX_FIRED) history.remove(history.iterator().next());
        JSONArray ids = new JSONArray();
        for (String entry : history) ids.put(entry);
        SharedPreferences.Editor editor = preferences(context).edit().putString(FIRED, ids.toString())
                .remove(SCHEDULED_ID).remove(SCHEDULED_AT);
        if (id.equals(pendingSnooze(context).id)) editor.remove(SNOOZE_ID).remove(SNOOZE_AT);
        commit(editor);
        return true;
    }

    private static void commit(SharedPreferences.Editor editor) {
        if (!editor.commit()) throw new IllegalStateException("Cannot persist native alarm state");
    }
}
