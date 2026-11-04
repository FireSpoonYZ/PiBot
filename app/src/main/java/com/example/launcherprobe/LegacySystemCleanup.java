package com.example.launcherprobe;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.service.notification.StatusBarNotification;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;
import android.util.Log;

import java.io.File;
import java.util.HashSet;
import java.util.Set;

/** One-time removal of obsolete scheduled work and notifications, without touching conversation data. */
final class LegacySystemCleanup {
    private static final String ACTION = "com.example.launcherprobe.RUN_SCHEDULED_TASKS";
    private static final String WORK_DB = "androidx.work.workdb";
    private static final String WORK_SERVICE = "androidx.work.impl.background.systemjob.SystemJobService";
    private LegacySystemCleanup() { }

    static synchronized void run(Context context) {
        Context app = context.getApplicationContext();
        if (!restoreNavigation(app)) {
            Log.w("LegacySystemCleanup", "Pending system navigation restoration requires user action");
            new Handler(Looper.getMainLooper()).post(() -> Toast.makeText(app,
                    "旧系统导航尚未恢复，请按 ADB 救援说明操作", Toast.LENGTH_LONG).show());
        }
        if (app.getSharedPreferences("obsolete_system_cleanup", Context.MODE_PRIVATE).getBoolean("complete", false)) return;
        try {
            cancelAlarms(app);
            cancelArchiveWork(app);
            NotificationManager notifications = app.getSystemService(NotificationManager.class);
            for (StatusBarNotification active : notifications.getActiveNotifications()) {
                String channel = active.getNotification().getChannelId();
                if ("task-attention".equals(channel) || "chat-execution".equals(channel) || "wake_word".equals(channel)) {
                    notifications.cancel(active.getTag(), active.getId());
                }
            }
            notifications.cancel(3107);
            notifications.cancel(7201);
            notifications.deleteNotificationChannel("task-attention");
            notifications.deleteNotificationChannel("chat-execution");
            notifications.deleteNotificationChannel("wake_word");
            for (String name : new String[]{"scheduled_tasks", "schedule_calendar", "task_widget", "task_notifications"}) {
                if (!app.deleteSharedPreferences(name)) throw new IllegalStateException("Unable to remove obsolete state: " + name);
            }
            if (!app.getSharedPreferences("obsolete_system_cleanup", Context.MODE_PRIVATE)
                    .edit().putBoolean("complete", true).commit()) throw new IllegalStateException("Unable to record cleanup");
        } catch (RuntimeException failure) {
            Log.w("LegacySystemCleanup", "Obsolete system cleanup will be retried", failure);
        }
    }

    private static boolean restoreNavigation(Context context) {
        SharedPreferences preferences = context.getSharedPreferences("gestures", Context.MODE_PRIVATE);
        if (!preferences.getBoolean("pending_restore", false)) return true;
        if (context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) != PackageManager.PERMISSION_GRANTED)
            return false;
        try {
            if (!Settings.Global.putInt(context.getContentResolver(), "force_fsg_nav_bar", 0)
                    || Settings.Global.getInt(context.getContentResolver(), "force_fsg_nav_bar", -1) != 0) return false;
            if (!preferences.edit().putBoolean("pending_restore", false).commit()) {
                preferences.edit().putBoolean("pending_restore", true).commit();
                return false;
            }
            return true;
        } catch (RuntimeException failure) {
            preferences.edit().putBoolean("pending_restore", true).apply();
            return false;
        }
    }

    private static void cancelAlarms(Context context) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        Intent old = new Intent(ACTION).setComponent(new ComponentName(context.getPackageName(),
                context.getPackageName() + ".ScheduledTaskReceiver"));
        for (int request = 0; request <= 2; request++) {
            PendingIntent pending = PendingIntent.getBroadcast(context, request, old,
                    PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
            if (pending != null) { alarms.cancel(pending); pending.cancel(); }
        }
        Intent show = new Intent(ACTION + ".SHOW").setComponent(new ComponentName(context.getPackageName(),
                context.getPackageName() + ".MainActivity"));
        PendingIntent pending = PendingIntent.getActivity(context, 2, show,
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
        if (pending != null) pending.cancel();
    }

    private static void cancelArchiveWork(Context context) {
        File[] databases = {new File(context.getNoBackupFilesDir(), WORK_DB), context.getDatabasePath(WORK_DB)};
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        ComponentName service = new ComponentName(context.getPackageName(), WORK_SERVICE);
        for (File path : databases) {
            if (!path.isFile()) continue;
            try (SQLiteDatabase db = SQLiteDatabase.openDatabase(path.getPath(), null, SQLiteDatabase.OPEN_READWRITE)) {
                Set<String> ids = new HashSet<>();
                Set<Integer> systemIds = new HashSet<>();
                try (Cursor cursor = db.rawQuery("SELECT work_spec_id FROM WorkName WHERE name = ?",
                        new String[]{"archive-cleanup"})) {
                    while (cursor.moveToNext()) ids.add(cursor.getString(0));
                }
                for (String id : ids) {
                    try (Cursor cursor = db.rawQuery("SELECT system_id FROM SystemIdInfo WHERE work_spec_id = ?",
                            new String[]{id})) {
                        while (cursor.moveToNext()) systemIds.add(cursor.getInt(0));
                    }
                }
                for (JobInfo job : scheduler.getAllPendingJobs()) {
                    if (!service.equals(job.getService())) continue;
                    String workId = job.getExtras().getString("EXTRA_WORK_SPEC_ID");
                    if (ids.contains(workId) || systemIds.contains(job.getId())) scheduler.cancel(job.getId());
                }
                db.beginTransaction();
                try {
                    db.execSQL("UPDATE WorkSpec SET state = 5 WHERE id IN (SELECT work_spec_id FROM WorkName WHERE name = ?)",
                            new Object[]{"archive-cleanup"});
                    db.execSQL("DELETE FROM SystemIdInfo WHERE work_spec_id IN (SELECT work_spec_id FROM WorkName WHERE name = ?)",
                            new Object[]{"archive-cleanup"});
                    db.setTransactionSuccessful();
                } finally { db.endTransaction(); }
            }
        }
    }
}
