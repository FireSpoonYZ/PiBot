package com.example.launcherprobe;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;

/** 本机 Host 前台服务；客户端生命周期拥有退出监听与重启，Manager 保留唯一进程及清理栅栏。 */
public final class BotHostService extends Service {
    static final String ACTION_START = "com.example.launcherprobe.action.HOST_START";
    static final String ACTION_STOP = "com.example.launcherprobe.action.HOST_STOP";

    private static final String CHANNEL = "bot-host";
    private static final int NOTIFICATION_ID = 3150;
    private static final int ERROR_NOTIFICATION_ID = 3151;
    private static final int REQUEST_NOTIFICATIONS = 3109;
    private static volatile BotHostService activeService;

    private final Handler main = new Handler(Looper.getMainLooper());
    private Object startAttempt;
    private CompletableFuture<JSONObject> starting;
    private final Runnable checkLocal = new Runnable() {
        @Override public void run() {
            BotClientService.pollLocal(BotHostService.this);
            boolean pending = !getSharedPreferences("bot_local_submissions", MODE_PRIVATE).getAll().isEmpty();
            main.postDelayed(this, pending ? 2000 : 15000);
        }
    };

    static void wakeLocalPolling() {
        BotHostService service = activeService;
        if (service == null) return;
        service.main.post(() -> {
            if (activeService != service) return;
            service.main.removeCallbacks(service.checkLocal);
            service.main.post(service.checkLocal);
        });
    }

    /** 可见入口启动客户端生命周期；通知权限仍由前台 Activity 请求。 */
    public static void startClientFromActivity(Activity activity) {
        if (activity == null || activity.isFinishing()) throw new IllegalArgumentException("需要前台 Activity");
        if (Build.VERSION.SDK_INT >= 33
                && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
        }
        activity.startForegroundService(new Intent(activity, BotClientService.class));
    }

    /** 已有客户端内的手动重试不得重新创建客户端生命周期。 */
    public static void startFromActivity(Activity activity) {
        if (activity == null || activity.isFinishing()) throw new IllegalArgumentException("需要前台 Activity");
        activity.startForegroundService(new Intent(activity, BotHostService.class).setAction(ACTION_START));
    }

    /** 旧的用户停止入口统一退出客户端；内部配置更新直接使用 Manager.stop。 */
    public static void stopFromUser(Context context) {
        BotClientService.exit(context);
    }

    static void startForClient(Context context) {
        try {
            context.startForegroundService(new Intent(context, BotHostService.class).setAction(ACTION_START));
        } catch (RuntimeException failure) {
            Log.e("BotHostService", "Host foreground service start failed", failure);
            BotClientService.hostServiceFailed();
        }
    }

    static void cancelPendingStart() {
        BotHostService service = activeService;
        if (service != null) {
            service.startAttempt = null;
            service.starting = null;
        }
    }

    static void recover(Consumer<Long> listener, boolean recovering) {
        BotHostService service = activeService;
        if (service != null) service.startHost(listener, recovering);
        else {
            Context context = BotClientService.activeContext();
            if (context != null) startForClient(context);
        }
    }

    static void retryWhenStartFails(Consumer<Long> listener) {
        BotHostService service = activeService;
        if (service == null || service.starting == null || service.starting.isDone()) return;
        Object attempt = service.startAttempt;
        service.starting.whenComplete((snapshot, error) -> service.main.post(() -> {
            if (error != null && activeService == service && service.startAttempt == attempt
                    && BotClientService.ownsHostListener(listener)) BotClientService.retryAfterConnection(listener);
        }));
    }

    static boolean ownsAttempt(Object attempt) {
        BotHostService service = activeService;
        return service != null && service.startAttempt == attempt;
    }

    @Override public void onCreate() {
        super.onCreate();
        activeService = this;
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, "AI Host", NotificationManager.IMPORTANCE_LOW));
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel("bot-client-tasks", "任务完成", NotificationManager.IMPORTANCE_DEFAULT));
        BotHostManager.get(this).attachService(this);
        main.post(checkLocal);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopFromUser(this);
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action)) return START_NOT_STICKY;
        startForeground(NOTIFICATION_ID, notification("正在启动"));
        Consumer<Long> listener = BotClientService.hostListener();
        if (listener != null) startHost(listener, false);
        else {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf(startId);
        }
        return START_NOT_STICKY;
    }

    private void startHost(Consumer<Long> listener, boolean recovering) {
        Object attempt = new Object();
        startAttempt = attempt;
        starting = null;
        BotHostManager manager = BotHostManager.get(this);
        manager.awaitStop().whenComplete((ignored, stopError) -> main.post(() -> {
            if (activeService != this || startAttempt != attempt || !BotClientService.ownsHostListener(listener)) return;
            if (stopError != null) {
                showError("AI Host 清理失败");
                updateNotification("清理失败");
                if (recovering) BotClientService.retryHost(listener, attempt);
                return;
            }
            updateNotification("正在启动");
            starting = manager.start();
            starting.whenComplete((snapshot, error) -> main.post(() -> {
                if (activeService != this || startAttempt != attempt || !BotClientService.ownsHostListener(listener)) return;
                if (error != null) {
                    if (!(error instanceof CancellationException)) {
                        showError("AI Host 启动失败");
                        updateNotification("启动失败");
                        if (recovering) BotClientService.retryHost(listener, attempt);
                    }
                } else {
                    refreshNotification();
                }
            }));
        }));
    }

    void onManagerStateChanged() { main.post(this::refreshNotification); }

    void onManagerStopped(boolean failed, String code) {
        main.post(() -> {
            BotHostManager manager = BotHostManager.get(this);
            if (!manager.isActiveService(this)) return;
            String phase = manager.snapshot().optString("phase");
            if ("running".equals(phase) || "starting".equals(phase)) return;
            if (failed && "failed".equals(phase)) {
                showError("AI Host 已停止：" + manager.snapshot().optString("errorCode", code));
            } else if (!failed && "stopped".equals(phase)) {
                getSystemService(NotificationManager.class).cancel(ERROR_NOTIFICATION_ID);
            }
            if (BotClientService.isActive()) {
                updateNotification("failed".equals(phase) ? "已停止，请检查配置" : "已停止");
            } else {
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
            }
        });
    }

    private void refreshNotification() {
        if (BotHostManager.get(this).snapshot().optString("phase").equals("running")) {
            getSystemService(NotificationManager.class).cancel(ERROR_NOTIFICATION_ID);
            updateNotification("本地 AI Host 正在运行");
        }
    }

    private void updateNotification(String text) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(text));
    }

    private void showError(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, openHostIntent(),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        getSystemService(NotificationManager.class).notify(ERROR_NOTIFICATION_ID,
                new Notification.Builder(this, CHANNEL)
                        .setSmallIcon(android.R.drawable.stat_notify_error)
                        .setContentTitle("AI Host")
                        .setContentText(text)
                        .setContentIntent(open)
                        .setAutoCancel(true)
                        .build());
    }

    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 1, openHostIntent(),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent exit = PendingIntent.getService(this, 2,
                new Intent(this, BotClientService.class).setAction(BotClientService.ACTION_EXIT),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("AI Host")
                .setContentText(text)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_menu_close_clear_cancel, "退出客户端", exit).build())
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build();
    }

    private Intent openHostIntent() {
        return new Intent(this, TauriMainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    @Override public void onDestroy() {
        if (activeService == this) activeService = null;
        startAttempt = null;
        starting = null;
        main.removeCallbacks(checkLocal);
        BotHostManager manager = BotHostManager.get(this);
        manager.onServiceDestroyed(this);
        manager.detachService(this);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
