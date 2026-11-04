package com.example.launcherprobe;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Host 定时任务闹钟接收器。 */
public final class BotHostScheduleReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        // 只取已存在的 Schedules；不存在或无已绑定 Host 则不执行/不补发。
        BotHostSchedules schedules = BotHostSchedules.instanceIfPresent();
        if (schedules == null) return;
        String action = intent == null ? null : intent.getAction();
        try {
            if (BotHostSchedules.ACTION_RUN.equals(action)) {
                schedules.onAlarm();
            } else if (Intent.ACTION_TIME_CHANGED.equals(action)
                    || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                    || AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(action)) {
                schedules.onClockChanged();
            }
        } catch (Exception failure) {
            Log.e("BotHostScheduleReceiver", "delivery-failed"); // 固定阶段日志，不回显 cause
        }
    }
}
