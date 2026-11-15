package de.nexus.app;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Only the alarm controls are shown over the keyguard; the app remains protected. */
public final class AlarmActivity extends Activity {
    public static final String EXTRA_WAKE = "wakeAndOpenRoutine";
    private static final int BACKGROUND = Color.rgb(21, 23, 25);
    private static final int TEXT = Color.rgb(239, 243, 247);
    private static final int ACCENT = Color.rgb(143, 201, 239);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private String occurrence;
    private TextView clock;
    private TextView status;
    private Button snooze;
    private Button wake;
    private boolean registered;
    private boolean openingRoutine;
    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            clock.setText(new SimpleDateFormat("HH:mm", Locale.GERMANY).format(new Date()));
            handler.postDelayed(this, 1000);
        }
    };
    private final BroadcastReceiver stateReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String incoming = intent.getStringExtra(AlarmService.EXTRA_OCCURRENCE);
            if (occurrence == null || !occurrence.equals(incoming)) return;
            if (!intent.getBooleanExtra("ringing", false)) {
                finish();
            } else {
                status.setText(intent.getStringExtra("message"));
                snooze.setEnabled(true);
                wake.setEnabled(true);
            }
        }
    };

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setVolumeControlStream(AudioManager.STREAM_ALARM);
        occurrence = getIntent().getStringExtra(AlarmService.EXTRA_OCCURRENCE);
        if (occurrence == null) occurrence = AlarmService.occurrenceId();
        if (!matchesCurrentAlarm()) { finish(); return; }
        createScreen();
        IntentFilter filter = new IntentFilter(AlarmService.ACTION_STATE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(stateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(stateReceiver, filter, getPackageName() + ".permission.ALARM_STATE", null);
        registered = true;
        if (getIntent().getBooleanExtra(EXTRA_WAKE, false)) openMorningRoutine();
    }

    private void createScreen() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BACKGROUND);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER);
        content.setPadding(dp(28), dp(36), dp(28), dp(36));
        scroll.addView(content, new ScrollView.LayoutParams(-1, -1));
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            int top, bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                top = bars.top; bottom = bars.bottom;
            } else { top = insets.getSystemWindowInsetTop(); bottom = insets.getSystemWindowInsetBottom(); }
            content.setPadding(dp(28), dp(36) + top, dp(28), dp(36) + bottom);
            return insets;
        });
        TextView brand = label("NEXUS · WECKER", 14, ACCENT);
        brand.setLetterSpacing(.16f);
        content.addView(brand, row(0, 20));
        clock = label("", 64, TEXT);
        clock.setTypeface(Typeface.create("sans-serif-light", Typeface.NORMAL));
        content.addView(clock, row(0, 12));
        content.addView(label("Guten Morgen", 30, TEXT), row(0, 12));
        status = label("Zeit für deinen Morgen.", 16, Color.rgb(174, 184, 193));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        content.addView(status, row(0, 32));
        wake = button("Aufstehen", true);
        wake.setOnClickListener(view -> openMorningRoutine());
        content.addView(wake, row(0, 12));
        snooze = button("Schlummern · " + AlarmStore.snoozeMinutes(this) + " Min.", false);
        snooze.setOnClickListener(view -> {
            snooze.setEnabled(false);
            wake.setEnabled(false);
            status.setText("Schlummern wird geplant …");
            sendAction(AlarmService.ACTION_SNOOZE);
        });
        content.addView(snooze, row(0, 22));
        content.addView(label("Aufstehen beendet den Ton und öffnet deine Morgenroutine.\nDie Android-Gerätesperre bleibt wirksam.", 13, Color.rgb(174, 184, 193)), row(0, 0));
        setContentView(scroll);
        scroll.requestApplyInsets();
    }

    private void openMorningRoutine() {
        if (openingRoutine || !matchesCurrentAlarm()) return;
        openingRoutine = true;
        try {
            // Persist first. A failed write must not silently discard the morning handoff.
            Intent morning = MainActivity.morningRoutineIntent(this);
            startActivity(morning);
            sendAction(AlarmService.ACTION_STOP);
            finish();
        } catch (RuntimeException failedStart) {
            openingRoutine = false;
            status.setText("Der Morgenstart konnte nicht gesichert oder geöffnet werden. Bitte erneut versuchen.");
            wake.setEnabled(true);
            snooze.setEnabled(true);
        }
    }

    private void sendAction(String action) {
        startService(new Intent(this, AlarmService.class).setAction(action)
                .putExtra(AlarmService.EXTRA_OCCURRENCE, occurrence));
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        occurrence = intent.getStringExtra(AlarmService.EXTRA_OCCURRENCE);
        if (!matchesCurrentAlarm()) { finish(); return; }
        if (intent.getBooleanExtra(EXTRA_WAKE, false)) openMorningRoutine();
    }

    @Override protected void onResume() {
        super.onResume();
        if (!matchesCurrentAlarm()) { finish(); return; }
        if (clock != null) handler.post(ticker);
    }

    @Override protected void onPause() { handler.removeCallbacks(ticker); super.onPause(); }

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (registered) unregisterReceiver(stateReceiver);
        super.onDestroy();
    }

    private TextView label(String text, int size, int color) {
        TextView label = new TextView(this);
        label.setText(text); label.setTextSize(size); label.setTextColor(color);
        label.setGravity(Gravity.CENTER);
        return label;
    }

    private boolean matchesCurrentAlarm() {
        return AlarmService.isRinging() && occurrence != null && occurrence.equals(AlarmService.occurrenceId());
    }

    private Button button(String text, boolean primary) {
        Button button = new Button(this);
        button.setText(text); button.setAllCaps(false); button.setTextSize(18);
        button.setMinHeight(dp(60));
        button.setBackgroundTintList(ColorStateList.valueOf(primary ? ACCENT : Color.rgb(41, 47, 53)));
        button.setTextColor(primary ? BACKGROUND : TEXT);
        return button;
    }

    private LinearLayout.LayoutParams row(int top, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(top); params.bottomMargin = dp(bottom);
        return params;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
