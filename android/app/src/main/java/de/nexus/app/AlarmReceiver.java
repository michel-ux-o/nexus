package de.nexus.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Explicit, non-exported PendingIntent destination for a registered occurrence. */
public final class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !AlarmScheduler.ACTION_ALARM.equals(intent.getAction())) return;
        try {
            if (!AlarmScheduler.claimAndScheduleNext(context, intent)) return;
            Intent ring = new Intent(context, AlarmService.class).setAction("de.nexus.app.action.RING")
                    .putExtra(AlarmScheduler.EXTRA_OCCURRENCE_ID,
                            intent.getStringExtra(AlarmScheduler.EXTRA_OCCURRENCE_ID));
            // An exact alarm for a user-requested alarm clock is a permitted background
            // foreground-service start. BootReceiver never starts this service.
            context.startForegroundService(ring);
        } catch (RuntimeException exception) {
            Log.e("NexusAlarmReceiver", "Cannot deliver alarm occurrence", exception);
        }
    }
}
