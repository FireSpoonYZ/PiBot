package com.example.launcherprobe;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;

import org.json.JSONObject;

/** 系统更新通知只打开客户端，不持有下载地址或安装操作。 */
final class ClientUpdateNotifications {
    static final String ACTION_OPEN = "com.example.launcherprobe.action.OPEN_CLIENT_UPDATE";
    static final String ACTION_STATUS_CHANGED = "com.example.launcherprobe.action.CLIENT_UPDATE_CHANGED";
    static final String CHANNEL = "client-updates";
    private static final int NOTIFICATION_ID = 3162;

    private ClientUpdateNotifications() { }

    static void show(Context context, String centerKey, JSONObject release) {
        long versionCode = release.optLong("versionCode");
        SharedPreferences prefs = context.getSharedPreferences("client_update_notifications", Context.MODE_PRIVATE);
        if (versionCode <= prefs.getLong(centerKey, 0L)
                || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (!manager.areNotificationsEnabled()) return;
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "客户端更新", NotificationManager.IMPORTANCE_DEFAULT));
        if (manager.getNotificationChannel(CHANNEL).getImportance() == NotificationManager.IMPORTANCE_NONE) return;
        Intent intent = new Intent(context, TauriMainActivity.class).setAction(ACTION_OPEN)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE);
        try {
            manager.notify(NOTIFICATION_ID, new Notification.Builder(context, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle("发现 PiBot 新版本")
                    .setContentText("版本 " + release.optString("version") + " 可用，点击查看")
                    .setContentIntent(open)
                    .setAutoCancel(true)
                    .build());
            prefs.edit().putLong(centerKey, versionCode).apply();
        } catch (SecurityException ignored) {
            // 通知权限可能在检查和发送之间被撤销；应用内仍可更新。
        }
    }

    static void cancel(Context context) {
        context.getSystemService(NotificationManager.class).cancel(NOTIFICATION_ID);
    }

    static void statusChanged(Context context) {
        context.sendBroadcast(new Intent(ACTION_STATUS_CHANGED).setPackage(context.getPackageName()));
    }
}
