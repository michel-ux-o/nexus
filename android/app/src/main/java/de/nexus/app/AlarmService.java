package de.nexus.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.media.ToneGenerator;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.widget.Toast;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Owns the ringing alarm independently of the WebView and the alarm activity. */
public final class AlarmService extends Service {
    public static final String ACTION_RING = "de.nexus.app.action.RING";
    public static final String ACTION_STOP = "de.nexus.app.action.STOP";
    public static final String ACTION_SNOOZE = "de.nexus.app.action.SNOOZE";
    public static final String ACTION_STATE = "de.nexus.app.action.ALARM_STATE";
    public static final String EXTRA_OCCURRENCE = "occurrenceId";
    public static final String CHANNEL_ID = "nexus_alarms_v1";
    public static final long MAX_RING_MILLIS = 10 * 60 * 1000L;
    private static final int NOTIFICATION_ID = 701;
    private static volatile boolean ringing;
    private static volatile String activeOccurrence;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<Uri> sources = new ArrayList<>();
    private MediaPlayer player;
    private ToneGenerator fallbackTone;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocus;
    private PowerManager.WakeLock wakeLock;
    private int sourceIndex;
    private boolean hasFocus;
    private String playbackMessage = "Zeit für deinen Morgen.";
    private final Runnable timeout = () -> endAlarm("Wecker nach 10 Minuten beendet.");
    private final Runnable beep = new Runnable() {
        @Override public void run() {
            if (!ringing || fallbackTone == null) return;
            if (hasFocus) fallbackTone.startTone(ToneGenerator.TONE_PROP_BEEP2, 1400);
            handler.postDelayed(this, 2000);
        }
    };

    public static boolean isRinging() { return ringing; }
    public static String occurrenceId() { return activeOccurrence; }

    static AudioAttributes alarmAudioAttributes() {
        return new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        String requestedOccurrence = intent.getStringExtra(EXTRA_OCCURRENCE);
        if (ACTION_RING.equals(action)) {
            if (!ringing) startAlarm(requestedOccurrence);
        } else if (ringing && (requestedOccurrence == null || requestedOccurrence.equals(activeOccurrence))) {
            if (ACTION_SNOOZE.equals(action)) {
                if (AlarmScheduler.snooze(this)) {
                    endAlarm("Schlummern: " + AlarmStore.snoozeMinutes(this) + " Minuten.");
                } else {
                    playbackMessage = "Schlummern nicht möglich. Genaue Alarme in Android freigeben.";
                    updateNotification();
                    broadcastState(playbackMessage);
                    Toast.makeText(this, playbackMessage, Toast.LENGTH_LONG).show();
                }
            } else if (ACTION_STOP.equals(action)) {
                endAlarm("Wecker beendet.");
            }
        } else if (!ringing) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private void startAlarm(String occurrence) {
        activeOccurrence = occurrence == null ? UUID.randomUUID().toString() : occurrence;
        ringing = true;
        try {
            createChannel();
            Notification notification = notification();
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            PowerManager power = getSystemService(PowerManager.class);
            if (power != null) {
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Nexus:AlarmPlayback");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(MAX_RING_MILLIS + 30_000L);
            }
            handler.postDelayed(timeout, MAX_RING_MILLIS);
            audioManager = getSystemService(AudioManager.class);
            audioFocus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(alarmAudioAttributes())
                    .setOnAudioFocusChangeListener(this::focusChanged, handler).build();
            hasFocus = audioManager != null && audioManager.requestAudioFocus(audioFocus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            if (!hasFocus) {
                playbackMessage = "Android hat die Tonausgabe vorübergehend blockiert.";
                updateNotification();
            }
            File local = privateSoundFile(AlarmStore.soundPath(this));
            if (local != null) sources.add(Uri.fromFile(local));
            addFallback(RingtoneManager.TYPE_ALARM);
            addFallback(RingtoneManager.TYPE_NOTIFICATION);
            addFallback(RingtoneManager.TYPE_RINGTONE);
            playNextSource();
            broadcastState(playbackMessage);
        } catch (RuntimeException error) {
            endAlarm("Wecker konnte nicht gestartet werden. Android-Einstellungen prüfen.");
        }
    }

    private File privateSoundFile(String path) {
        if (path == null || path.isEmpty()) return null;
        try {
            File file = new File(path).getCanonicalFile();
            String root = getFilesDir().getCanonicalPath() + File.separator;
            return file.getPath().startsWith(root) && file.isFile() ? file : null;
        } catch (Exception ignored) { return null; }
    }

    private void addFallback(int type) {
        Uri uri = RingtoneManager.getDefaultUri(type);
        if (uri != null && !sources.contains(uri)) sources.add(uri);
    }

    private void playNextSource() {
        releasePlayer();
        if (!ringing) return;
        if (sourceIndex >= sources.size()) {
            try {
                fallbackTone = new ToneGenerator(AudioManager.STREAM_ALARM, 100);
                handler.post(beep);
                playbackMessage = "Ersatzsignal – der gewählte Ton ist nicht verfügbar.";
                updateNotification();
                broadcastState(playbackMessage);
            } catch (RuntimeException ignored) {
                playbackMessage = "Keine Tonausgabe möglich. Bitte Alarm-Lautstärke prüfen.";
                updateNotification();
                broadcastState(playbackMessage);
            }
            return;
        }
        Uri source = sources.get(sourceIndex++);
        MediaPlayer candidate = new MediaPlayer();
        player = candidate;
        try {
            candidate.setAudioAttributes(alarmAudioAttributes());
            candidate.setDataSource(this, source);
            candidate.setLooping(true);
            candidate.setOnPreparedListener(prepared -> {
                if (ringing && player == prepared && hasFocus) prepared.start();
            });
            candidate.setOnErrorListener((failed, what, extra) -> {
                if (player == failed) handler.post(this::playNextSource);
                return true;
            });
            candidate.prepareAsync();
        } catch (Exception error) {
            handler.post(this::playNextSource);
        }
    }

    private void focusChanged(int focus) {
        hasFocus = focus == AudioManager.AUDIOFOCUS_GAIN;
        if (player == null) return;
        try {
            if (hasFocus) player.start();
            else if (player.isPlaying()) player.pause();
        } catch (IllegalStateException ignored) { /* prepareAsync has not finished yet. */ }
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Nexus Wecker", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Geplante Wecker auf diesem Gerät. Ton spielt der native Weckdienst.");
        channel.setSound(null, alarmAudioAttributes());
        channel.enableVibration(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification notification() {
        Intent screen = new Intent(this, AlarmActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_OCCURRENCE, activeOccurrence);
        PendingIntent open = PendingIntent.getActivity(this, 701, screen, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent snooze = PendingIntent.getService(this, 702, new Intent(this, AlarmService.class)
                .setAction(ACTION_SNOOZE).putExtra(EXTRA_OCCURRENCE, activeOccurrence), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent wake = PendingIntent.getActivity(this, 703, new Intent(screen)
                .putExtra(AlarmActivity.EXTRA_WAKE, true), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle("Nexus · Guten Morgen")
                .setContentText(playbackMessage)
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setContentIntent(open).setOngoing(true).setAutoCancel(false)
                .addAction(new Notification.Action.Builder(null, "Schlummern", snooze).build())
                .addAction(new Notification.Action.Builder(null, "Aufstehen", wake).build());
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        NotificationManager manager = getSystemService(NotificationManager.class);
        boolean allowed = manager != null && manager.areNotificationsEnabled()
                && (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                && (Build.VERSION.SDK_INT < 34 || manager.canUseFullScreenIntent());
        if (allowed) builder.setFullScreenIntent(open, true);
        return builder.build();
    }

    private void updateNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, notification());
    }

    private void broadcastState(String message) {
        sendBroadcast(new Intent(ACTION_STATE).setPackage(getPackageName())
                .putExtra("ringing", ringing).putExtra("message", message)
                .putExtra(EXTRA_OCCURRENCE, activeOccurrence));
    }

    private void endAlarm(String message) {
        ringing = false;
        cleanup();
        broadcastState(message);
        activeOccurrence = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void releasePlayer() {
        if (player != null) {
            player.setOnPreparedListener(null);
            player.setOnErrorListener(null);
            player.release();
            player = null;
        }
    }

    private void cleanup() {
        handler.removeCallbacksAndMessages(null);
        releasePlayer();
        if (fallbackTone != null) { fallbackTone.release(); fallbackTone = null; }
        if (audioManager != null && audioFocus != null) audioManager.abandonAudioFocusRequest(audioFocus);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        audioFocus = null;
        sources.clear();
        sourceIndex = 0;
    }

    @Override public void onDestroy() {
        boolean wasRinging = ringing;
        ringing = false;
        cleanup();
        if (wasRinging) broadcastState("Wecker beendet.");
        activeOccurrence = null;
        super.onDestroy();
    }
}
