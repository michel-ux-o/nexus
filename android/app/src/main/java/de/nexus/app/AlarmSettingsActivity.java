package de.nexus.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.TimePickerDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadataRetriever;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.text.DateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Device-local controls. No WebView, server or shared-storage permission is involved. */
public final class AlarmSettingsActivity extends Activity {
    private static final int PICK_MP3 = 801;
    private static final int REQUEST_NOTIFICATIONS = 802;
    private static final long MAX_SOUND_BYTES = 20 * 1024 * 1024L;
    private static final int BACKGROUND = Color.rgb(21, 23, 25);
    private static final int SURFACE = Color.rgb(39, 44, 49);
    private static final int TEXT = Color.rgb(239, 243, 247);
    private static final int MUTED = Color.rgb(174, 184, 193);
    private static final int ACCENT = Color.rgb(143, 201, 239);
    private static final String[] WEEKDAYS = {"Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"};
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService importExecutor = Executors.newSingleThreadExecutor();
    private final Switch[] enabled = new Switch[7];
    private final Button[] times = new Button[7];
    private final int[] hours = new int[7];
    private final int[] minutes = new int[7];
    private LinearLayout content;
    private TextView result;
    private TextView soundLabel;
    private TextView permissions;
    private TextView nextAlarm;
    private Button saveButton;
    private Button chooseSound;
    private Button defaultSound;
    private Button previewButton;
    private Button stopPreviewButton;
    private Button snoozeButton;
    private String soundPath;
    private String soundName;
    private String persistedSoundPath;
    private int snoozeMinutes;
    private boolean importing;
    private boolean askedNotifications;
    private MediaPlayer preview;
    private AudioManager previewAudioManager;
    private AudioFocusRequest previewFocus;
    private final Runnable previewTimeout = () -> stopPreview("Vorschau beendet.");

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setTitle("Wecker auf diesem Gerät");
        setVolumeControlStream(AudioManager.STREAM_ALARM);
        JSONObject persisted = AlarmStore.load(this);
        persistedSoundPath = nullableString(persisted, "soundPath");
        JSONObject config = persisted;
        if (state != null) {
            try { config = new JSONObject(state.getString("alarmDraft", persisted.toString())); }
            catch (JSONException ignored) { config = persisted; }
            askedNotifications = state.getBoolean("askedNotifications", false);
        }
        soundPath = nullableString(config, "soundPath");
        soundName = nullableString(config, "soundName");
        snoozeMinutes = config.optInt("snoozeMinutes", 10);
        createScreen(config);
    }

    private void createScreen(JSONObject config) {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BACKGROUND);
        scroll.setFillViewport(true);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(22), dp(20), dp(28));
        scroll.addView(content, new ScrollView.LayoutParams(-1, -2));
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            int left = 0, right = 0, top, bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left = bars.left; right = bars.right; top = bars.top; bottom = bars.bottom;
            } else { top = insets.getSystemWindowInsetTop(); bottom = insets.getSystemWindowInsetBottom(); }
            content.setPadding(dp(20) + left, dp(22) + top, dp(20) + right, dp(28) + bottom);
            return insets;
        });
        Button back = button("‹ Zurück zu Nexus", false);
        back.setOnClickListener(view -> finish());
        add(back, 0, 14);
        add(label("NEXUS · ANDROID", 13, ACCENT), 0, 8);
        TextView title = label("Dein Wecker", 30, TEXT);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        add(title, 0, 10);
        add(label("Weckzeiten und Töne gelten nur auf diesem Android-Gerät. Geplante Wecker funktionieren auch ohne Internet und bei geschlossener Nexus-Oberfläche.", 15, MUTED), 0, 18);
        nextAlarm = label("", 15, ACCENT);
        add(nextAlarm, 0, 22);
        add(label("Wochentage", 21, TEXT), 0, 8);
        JSONArray days = config.optJSONArray("days");
        for (int index = 0; index < 7; index++) {
            final int dayIndex = index;
            JSONObject day = findDay(days, index + 1);
            hours[index] = day.optInt("hour", 7);
            minutes[index] = day.optInt("minute", 0);
            LinearLayout row = new LinearLayout(this);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(12), dp(4), dp(10), dp(4));
            row.setBackgroundColor(SURFACE);
            enabled[index] = new Switch(this);
            enabled[index].setText(WEEKDAYS[index]);
            enabled[index].setTextColor(TEXT);
            enabled[index].setTextSize(16);
            enabled[index].setMinHeight(dp(52));
            enabled[index].setChecked(day.optBoolean("enabled", false));
            enabled[index].setThumbTintList(ColorStateList.valueOf(ACCENT));
            enabled[index].setPadding(0, 0, dp(8), 0);
            row.addView(enabled[index], new LinearLayout.LayoutParams(0, -2, 1));
            times[index] = button(time(index), false);
            times[index].setContentDescription("Weckzeit " + WEEKDAYS[index] + ": " + time(index));
            times[index].setOnClickListener(view -> new TimePickerDialog(this, (picker, hour, minute) -> {
                hours[dayIndex] = hour; minutes[dayIndex] = minute;
                times[dayIndex].setText(time(dayIndex));
                times[dayIndex].setContentDescription("Weckzeit " + WEEKDAYS[dayIndex] + ": " + time(dayIndex));
                showResult("Änderungen mit Speichern übernehmen.");
            }, hours[dayIndex], minutes[dayIndex], true).show());
            row.addView(times[index], new LinearLayout.LayoutParams(-2, -2));
            enabled[index].setOnCheckedChangeListener((button, checked) -> showResult("Änderungen mit Speichern übernehmen."));
            add(row, 0, 7);
        }
        snoozeButton = button("Schlummerdauer: " + snoozeMinutes + " Minuten", false);
        snoozeButton.setOnClickListener(view -> {
            final int[] values = {5, 10, 15, 20, 30};
            new AlertDialog.Builder(this).setTitle("Schlummerdauer")
                    .setItems(new String[]{"5 Minuten", "10 Minuten", "15 Minuten", "20 Minuten", "30 Minuten"}, (dialog, which) -> {
                        snoozeMinutes = values[which];
                        snoozeButton.setText("Schlummerdauer: " + snoozeMinutes + " Minuten");
                        showResult("Änderungen mit Speichern übernehmen.");
                    }).show();
        });
        add(snoozeButton, 8, 22);
        add(label("Weckton", 21, TEXT), 0, 8);
        soundLabel = label("", 15, MUTED);
        soundLabel.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        updateSoundLabel();
        add(soundLabel, 0, 6);
        chooseSound = button("Lokale MP3 auswählen", false);
        chooseSound.setOnClickListener(view -> pickSound());
        add(chooseSound, 0, 4);
        defaultSound = button("Android-Standardton verwenden", false);
        defaultSound.setOnClickListener(view -> {
            stopPreview(null);
            deleteUnsavedSound(soundPath);
            soundPath = null; soundName = null;
            updateSoundLabel();
            showResult("Standardton ausgewählt. Mit Speichern übernehmen.");
        });
        add(defaultSound, 0, 4);
        previewButton = button("Ton vorhören", false);
        previewButton.setOnClickListener(view -> startPreview(false));
        add(previewButton, 0, 4);
        stopPreviewButton = button("Vorschau stoppen", false);
        stopPreviewButton.setEnabled(false);
        stopPreviewButton.setOnClickListener(view -> stopPreview("Vorschau beendet."));
        add(stopPreviewButton, 0, 8);
        add(label("MP3 bis 20 MB. Nexus kopiert die Datei in den privaten Gerätespeicher. Der Ton bleibt offline verfügbar; fehlt er, ertönt der Android-Standardton. Die Lautstärketasten regeln hier die Alarm-Lautstärke.", 13, MUTED), 0, 22);
        saveButton = button("Wecker speichern", true);
        saveButton.setOnClickListener(view -> saveSettings());
        add(saveButton, 0, 8);
        result = label("Änderungen werden erst mit Speichern übernommen.", 15, ACCENT);
        result.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        add(result, 0, 24);
        add(label("Android-Freigaben", 21, TEXT), 0, 8);
        permissions = label("", 14, MUTED);
        add(permissions, 0, 8);
        Button exact = button("Genaue Alarme freigeben", false);
        exact.setEnabled(Build.VERSION.SDK_INT >= 31);
        exact.setOnClickListener(view -> openSettings(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getPackageName()))));
        add(exact, 0, 4);
        Button notifications = button("Benachrichtigungen freigeben", false);
        notifications.setOnClickListener(view -> requestNotifications());
        add(notifications, 0, 4);
        Button fullScreen = button("Weckbildschirm freigeben", false);
        fullScreen.setEnabled(Build.VERSION.SDK_INT >= 34);
        fullScreen.setOnClickListener(view -> openSettings(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName()))));
        add(fullScreen, 0, 14);
        add(label(Build.MANUFACTURER + " " + Build.MODEL + " · Android " + Build.VERSION.RELEASE + "\n\nPrüfe bei diesem Gerät auch die Akku- und Hintergrundregeln für Nexus. Hersteller können Wecker zusätzlich einschränken. Nach erzwungenem Beenden in Android Nexus erneut öffnen. Bei Lautlos-/Nicht-stören-Regeln die Alarm-Lautstärke und Alarm-Ausnahmen prüfen.", 13, MUTED), 0, 6);
        Button battery = button("Android-Akkueinstellungen öffnen", false);
        battery.setOnClickListener(view -> openSettings(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)));
        add(battery, 0, 0);
        setContentView(scroll);
        scroll.requestApplyInsets();
    }

    private JSONObject draft() throws JSONException {
        JSONObject config = new JSONObject();
        JSONArray days = new JSONArray();
        for (int index = 0; index < 7; index++) {
            days.put(new JSONObject().put("weekday", index + 1).put("enabled", enabled[index].isChecked())
                    .put("hour", hours[index]).put("minute", minutes[index]));
        }
        return config.put("days", days).put("snoozeMinutes", snoozeMinutes)
                .put("soundPath", soundPath == null ? JSONObject.NULL : soundPath)
                .put("soundName", soundName == null ? JSONObject.NULL : soundName);
    }

    private void saveSettings() {
        stopPreview(null);
        try {
            String previous = persistedSoundPath;
            JSONObject saved = AlarmStore.save(this, draft());
            persistedSoundPath = nullableString(saved, "soundPath");
            soundPath = persistedSoundPath;
            soundName = nullableString(saved, "soundName");
            boolean scheduled = AlarmScheduler.reschedule(this);
            if (previous != null && !previous.equals(persistedSoundPath)) deleteManagedSound(previous);
            updateSoundLabel();
            refreshPermissions();
            boolean any = false;
            for (Switch day : enabled) any |= day.isChecked();
            String message;
            if (!any) message = "Gespeichert. Alle Wochentagswecker sind ausgeschaltet.";
            else if (!scheduled || !AlarmScheduler.canScheduleExactAlarms(this)) message = "Gespeichert, aber nicht geplant: Bitte genaue Alarme in Android freigeben.";
            else if (!notificationsAllowed()) message = "Gespeichert und geplant. Benachrichtigungen sind gesperrt: Der Weckbildschirm ist nicht verfügbar. Bitte freigeben.";
            else if (!fullScreenAllowed()) message = "Gespeichert und geplant. Vollbild fehlt: Der Wecker erscheint als Benachrichtigung. Weckbildschirm separat freigeben.";
            else message = "Gespeichert. " + nextAlarmText();
            showResult(message);
            Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        } catch (Exception error) {
            showResult("Nicht gespeichert. " + safeMessage(error, "Bitte Einstellungen erneut prüfen."));
        }
    }

    private void pickSound() {
        stopPreview(null);
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("audio/*").putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"audio/mpeg", "audio/mp3", "audio/x-mp3"})
                .putExtra(Intent.EXTRA_LOCAL_ONLY, true);
        try { startActivityForResult(picker, PICK_MP3); }
        catch (ActivityNotFoundException error) { showResult("Auf diesem Gerät ist keine Dateiauswahl verfügbar."); }
    }

    @Override protected void onActivityResult(int request, int code, Intent data) {
        super.onActivityResult(request, code, data);
        if (request != PICK_MP3 || code != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        if (!"content".equals(uri.getScheme())) { showResult("Bitte eine lokale MP3 über die Android-Dateiauswahl wählen."); return; }
        setImporting(true);
        showResult("MP3 wird geprüft und auf dieses Gerät kopiert …");
        importExecutor.execute(() -> importSound(uri));
    }

    private void importSound(Uri uri) {
        File copied = null;
        try {
            String name = "Lokaler Weckton.mp3";
            try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (nameColumn >= 0 && !cursor.isNull(nameColumn)) name = cursor.getString(nameColumn);
                    int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                    if (sizeColumn >= 0 && !cursor.isNull(sizeColumn) && cursor.getLong(sizeColumn) > MAX_SOUND_BYTES)
                        throw new IllegalArgumentException("Die MP3 darf höchstens 20 MB groß sein.");
                }
            }
            File directory = new File(getFilesDir(), "alarm-tones");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("Privater Tonspeicher nicht verfügbar.");
            copied = new File(directory, "alarm-tone-" + UUID.randomUUID() + ".mp3");
            long total = 0;
            try (InputStream input = getContentResolver().openInputStream(uri); FileOutputStream output = new FileOutputStream(copied)) {
                if (input == null) throw new IllegalArgumentException("Die ausgewählte Datei kann nicht gelesen werden.");
                byte[] buffer = new byte[16 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                    total += count;
                    if (total > MAX_SOUND_BYTES) throw new IllegalArgumentException("Die MP3 darf höchstens 20 MB groß sein.");
                    output.write(buffer, 0, count);
                }
                output.getFD().sync();
            }
            if (total == 0) throw new IllegalArgumentException("Die ausgewählte Datei ist leer.");
            MediaMetadataRetriever metadata = new MediaMetadataRetriever();
            try {
                metadata.setDataSource(copied.getAbsolutePath());
                String mime = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE);
                String duration = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
                if (!("audio/mpeg".equals(mime) || "audio/mp3".equals(mime)) || duration == null || Long.parseLong(duration) <= 0)
                    throw new IllegalArgumentException("Bitte eine gültige, abspielbare MP3 auswählen.");
            } finally { metadata.release(); }
            final File ready = copied;
            final String displayName = name.replaceAll("[\\p{Cntrl}]", " ").trim();
            handler.post(() -> {
                if (isDestroyed() || isFinishing()) { ready.delete(); return; }
                deleteUnsavedSound(soundPath);
                soundPath = ready.getAbsolutePath();
                soundName = displayName.isEmpty() ? "Lokaler Weckton.mp3" : displayName.substring(0, Math.min(180, displayName.length()));
                setImporting(false);
                updateSoundLabel();
                showResult("MP3 kopiert und geprüft. Mit Speichern übernehmen.");
            });
        } catch (Exception error) {
            if (copied != null) copied.delete();
            String message = safeMessage(error, "Die MP3 konnte nicht importiert werden. Bitte eine andere Datei wählen.");
            handler.post(() -> {
                if (isDestroyed() || isFinishing()) return;
                setImporting(false);
                showResult("Ton nicht geändert. " + message);
            });
        }
    }

    private void setImporting(boolean value) {
        importing = value;
        saveButton.setEnabled(!value); chooseSound.setEnabled(!value); defaultSound.setEnabled(!value);
        previewButton.setEnabled(!value);
    }

    private void startPreview(boolean fallback) {
        stopPreview(null);
        if (AlarmService.isRinging()) { showResult("Ein Wecker klingelt bereits. Vorschau danach erneut starten."); return; }
        try {
            previewAudioManager = getSystemService(AudioManager.class);
            previewFocus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(AlarmService.alarmAudioAttributes())
                    .setOnAudioFocusChangeListener(change -> {
                        if (change < 0) stopPreview("Vorschau durch Android unterbrochen.");
                    }, handler).build();
            if (previewAudioManager == null || previewAudioManager.requestAudioFocus(previewFocus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                stopPreview("Android blockiert die Tonausgabe gerade. Bitte später erneut vorhören."); return;
            }
            MediaPlayer candidate = new MediaPlayer();
            preview = candidate;
            candidate.setAudioAttributes(AlarmService.alarmAudioAttributes());
            if (!fallback && soundPath != null) candidate.setDataSource(soundPath);
            else candidate.setDataSource(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM));
            candidate.setOnPreparedListener(prepared -> {
                if (preview != prepared || isFinishing()) return;
                prepared.start();
                showResult(fallback ? "Android-Ersatzton läuft · höchstens 15 Sekunden." : "Vorschau läuft · höchstens 15 Sekunden.");
            });
            candidate.setOnCompletionListener(completed -> stopPreview("Vorschau beendet."));
            candidate.setOnErrorListener((failed, what, extra) -> {
                if (preview == failed) {
                    if (!fallback) handler.post(() -> startPreview(true));
                    else handler.post(() -> stopPreview("Android-Standardton nicht verfügbar. Alarm-Lautstärke und Standardton prüfen."));
                }
                return true;
            });
            candidate.prepareAsync();
            previewButton.setEnabled(false); stopPreviewButton.setEnabled(true);
            handler.postDelayed(previewTimeout, 15_000);
        } catch (Exception error) {
            if (!fallback) startPreview(true);
            else stopPreview("Tonvorschau nicht möglich. Android-Standardton prüfen.");
        }
    }

    private void stopPreview(String message) {
        handler.removeCallbacks(previewTimeout);
        if (preview != null) {
            preview.setOnPreparedListener(null); preview.setOnErrorListener(null); preview.setOnCompletionListener(null);
            preview.release(); preview = null;
        }
        if (previewAudioManager != null && previewFocus != null) previewAudioManager.abandonAudioFocusRequest(previewFocus);
        previewFocus = null;
        if (previewButton != null) previewButton.setEnabled(!importing);
        if (stopPreviewButton != null) stopPreviewButton.setEnabled(false);
        if (message != null) showResult(message);
    }

    private void refreshPermissions() {
        boolean exact = AlarmScheduler.canScheduleExactAlarms(this);
        permissions.setText("Genaue Alarme: " + (exact ? "freigegeben" : "fehlen – kein genauer Wecker geplant")
                + "\nBenachrichtigungen: " + (notificationsAllowed() ? "freigegeben" : "gesperrt – keine Weckeranzeige")
                + "\nWeckbildschirm: " + (fullScreenAllowed() ? "von Android erlaubt" : "nicht freigegeben – Benachrichtigung verwenden")
                + "\n\nAndroid entscheidet je nach Sperrzustand, ob Vollbild oder eine hervorgehobene Benachrichtigung erscheint.");
        nextAlarm.setText(nextAlarmText());
    }

    private boolean notificationsAllowed() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || !manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        NotificationChannel channel = manager.getNotificationChannel(AlarmService.CHANNEL_ID);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    private boolean fullScreenAllowed() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        return Build.VERSION.SDK_INT < 34 || (manager != null && manager.canUseFullScreenIntent());
    }

    private void requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && (!askedNotifications || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
            askedNotifications = true;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
        } else openSettings(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
    }

    private void openSettings(Intent intent) {
        stopPreview(null);
        try { startActivity(intent); }
        catch (ActivityNotFoundException error) {
            try { startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); }
            catch (ActivityNotFoundException ignored) { showResult("Android-Einstellungen für Nexus bitte manuell öffnen."); }
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] names, int[] granted) {
        super.onRequestPermissionsResult(request, names, granted);
        if (request == REQUEST_NOTIFICATIONS) {
            refreshPermissions();
            showResult(notificationsAllowed() ? "Benachrichtigungen sind freigegeben." : "Benachrichtigungen bleiben gesperrt. In Android freigeben, damit der Wecker sichtbar ist.");
        }
    }

    @Override protected void onResume() {
        super.onResume();
        AlarmScheduler.reschedule(this);
        if (permissions != null) refreshPermissions();
    }

    @Override protected void onPause() { stopPreview(null); super.onPause(); }

    @Override protected void onSaveInstanceState(Bundle state) {
        try { state.putString("alarmDraft", draft().toString()); } catch (JSONException ignored) { }
        state.putBoolean("askedNotifications", askedNotifications);
        super.onSaveInstanceState(state);
    }

    @Override protected void onDestroy() {
        stopPreview(null);
        importExecutor.shutdownNow();
        if (isFinishing()) deleteUnsavedSound(soundPath);
        super.onDestroy();
    }

    private String nextAlarmText() {
        long next = AlarmScheduler.nextTriggerMillis(this);
        return next > 0 ? "Nächster Alarm: " + DateFormat.getDateTimeInstance(DateFormat.FULL, DateFormat.SHORT, Locale.GERMANY).format(new Date(next)) : "Kein Alarm in Android geplant.";
    }

    private void updateSoundLabel() { soundLabel.setText(soundPath == null ? "Android-Standardalarmton" : "Auf diesem Gerät: " + (soundName == null ? "Lokale MP3" : soundName)); }
    private void showResult(String message) { if (result != null) result.setText(message); }
    private String time(int index) { return String.format(Locale.GERMANY, "%02d:%02d", hours[index], minutes[index]); }
    private static String nullableString(JSONObject json, String key) { return json.isNull(key) ? null : json.optString(key, null); }

    private static JSONObject findDay(JSONArray days, int weekday) {
        if (days != null) for (int index = 0; index < days.length(); index++) {
            JSONObject day = days.optJSONObject(index);
            if (day != null && day.optInt("weekday") == weekday) return day;
        }
        return new JSONObject();
    }

    private void deleteUnsavedSound(String path) {
        if (path != null && !path.equals(persistedSoundPath)) deleteManagedSound(path);
    }

    private void deleteManagedSound(String path) {
        try {
            File file = new File(path).getCanonicalFile();
            File directory = new File(getFilesDir(), "alarm-tones").getCanonicalFile();
            if (directory.equals(file.getParentFile()) && file.getName().matches("alarm-tone-[a-f0-9-]+\\.mp3")) file.delete();
        } catch (Exception ignored) { }
    }

    private static String safeMessage(Exception error, String fallback) {
        return error instanceof IllegalArgumentException || error instanceof IllegalStateException ? (error.getMessage() == null ? fallback : error.getMessage()) : fallback;
    }

    private TextView label(String text, int size, int color) {
        TextView label = new TextView(this);
        label.setText(text); label.setTextSize(size); label.setTextColor(color);
        return label;
    }

    private Button button(String text, boolean primary) {
        Button button = new Button(this);
        button.setText(text); button.setAllCaps(false); button.setTextSize(15); button.setMinHeight(dp(50));
        button.setTextColor(primary ? BACKGROUND : TEXT);
        button.setBackgroundTintList(ColorStateList.valueOf(primary ? ACCENT : SURFACE));
        return button;
    }

    private void add(View view, int top, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(top); params.bottomMargin = dp(bottom);
        content.addView(view, params);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
