package com.example.launcherprobe;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.Manifest;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import java.util.HashMap;
import java.util.Map;
import java.util.Iterator;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.concurrent.atomic.AtomicInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONArray;
import org.json.JSONObject;

/** 客户端前台生命周期：持有本机 Host 退出监听，中心连接独立恢复。 */
public final class BotClientService extends Service {
    static final String ACTION_EXIT = "com.example.launcherprobe.action.CLIENT_EXIT";
    static final String ACTION_CLOSE_UI = "com.example.launcherprobe.action.CLIENT_CLOSE_UI";
    private static final String CHANNEL = "bot-client-connection";
    private static final int NOTIFICATION_ID = 3160;
    private static volatile BotClientService activeService;
    private static final Map<String, String> visibleChats = new HashMap<>();
    private static final AtomicBoolean localPolling = new AtomicBoolean();
    private static final Handler localHandler = new Handler(Looper.getMainLooper());

    static synchronized void setVisibility(String owner, String deviceId, String botId, boolean visible) {
        String chat = deviceId + String.valueOf((char) 0) + botId;
        if (visible) visibleChats.put(owner, chat);
        else if (chat.equals(visibleChats.get(owner))) visibleChats.remove(owner);
    }

    static synchronized void clearVisibility(String owner) { visibleChats.remove(owner); }

    static synchronized boolean isVisible(String deviceId, String botId) {
        return visibleChats.containsValue(deviceId + String.valueOf((char) 0) + botId);
    }
    private final Handler main = new Handler(Looper.getMainLooper());
    private ConnectivityManager connectivity;
    private volatile boolean alive;
    private final AtomicInteger lifecycle = new AtomicInteger();
    private CompletableFuture<Void> exitCleanup;
    private volatile Consumer<Long> hostExitListener;
    private Runnable hostRetry;
    private boolean polling;
    private boolean scanHasPending;
    private boolean previousPending;
    private boolean rescanRequested;
    private final ConnectivityManager.NetworkCallback network = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) {
            if (!alive) return;
            int epoch = lifecycle.get();
            Consumer<Long> listener = hostExitListener;
            BotHostClient.get(BotClientService.this).checkConnection(true);
            main.post(() -> {
                if (lifecycle.get() == epoch) retryHostOnConnection(listener);
            });
        }
    };
    private final Runnable check = new Runnable() {
        @Override public void run() {
            if (!alive) return;
            BotHostClient.get(BotClientService.this).checkConnection();
            if (!getSharedPreferences("bot_client_connection", MODE_PRIVATE).getBoolean("enabled", true)) {
                main.postDelayed(this, 15000);
                return;
            }
            if (!polling) {
                polling = true;
                previousPending = scanHasPending;
                scanHasPending = false;
                scanPage(null, lifecycle.get());
            }
        }
    };

    static void exit(Context context) {
        context.startService(new Intent(context, BotClientService.class).setAction(ACTION_EXIT));
    }

    static boolean isActive() {
        BotClientService service = activeService;
        return service != null && service.alive;
    }

    static Context activeContext() { return activeService; }

    static BooleanSupplier ownerOpen() {
        BotClientService service = activeService;
        int epoch = service == null ? -1 : service.lifecycle.get();
        return () -> service != null && activeService == service && service.alive && service.lifecycle.get() == epoch;
    }

    static Consumer<Long> hostListener() {
        BotClientService service = activeService;
        return service != null && service.alive ? service.hostExitListener : null;
    }

    static boolean ownsHostListener(Consumer<Long> listener) {
        return listener != null && hostListener() == listener;
    }

    static void hostServiceFailed() {
        BotClientService service = activeService;
        if (service == null) return;
        int epoch = service.lifecycle.get();
        service.main.post(() -> {
            if (activeService == service && service.alive && service.lifecycle.get() == epoch)
                service.updateNotification("本机 Host 前台服务启动失败");
        });
    }

    private void attachHostListener() {
        Consumer<Long> listener = new Consumer<Long>() {
            @Override public void accept(Long generation) {
                main.post(() -> {
                    if (!ownsHostListener(this) || !BotHostManager.get(BotClientService.this).isCurrentExit(generation)) return;
                    Log.i("BotClientService", "Host child exited generation=" + generation + "; retry scheduled");
                    scheduleHostRetry(this, null, generation, true);
                });
            }
        };
        hostExitListener = listener;
        BotHostManager.get(this).setExitListener(listener);
    }

    private void detachHostListener() {
        Consumer<Long> listener = hostExitListener;
        hostExitListener = null;
        if (listener != null) BotHostManager.get(this).clearExitListener(listener);
        if (hostRetry != null) main.removeCallbacks(hostRetry);
        hostRetry = null;
        BotHostService.cancelPendingStart();
    }

    static void retryHost(Consumer<Long> listener, Object attempt) {
        BotClientService service = activeService;
        if (service != null) service.scheduleHostRetry(listener, attempt, null, true);
    }

    static void centerReady() {
        BotClientService service = activeService;
        if (service == null) return;
        int epoch = service.lifecycle.get();
        Consumer<Long> listener = service.hostExitListener;
        service.main.post(() -> {
            if (service.lifecycle.get() == epoch) service.retryHostOnConnection(listener);
        });
    }

    private void retryHostOnConnection(Consumer<Long> listener) {
        if (!ownsHostListener(listener)) return;
        Long generation = BotHostManager.get(this).configuredFailureGeneration();
        if (generation != null) scheduleHostRetry(listener, null, generation, false);
        else BotHostService.retryWhenStartFails(listener);
    }

    static void retryAfterConnection(Consumer<Long> listener) {
        BotClientService service = activeService;
        if (service != null) service.retryHostOnConnection(listener);
    }

    private void scheduleHostRetry(Consumer<Long> listener, Object attempt, Long failedGeneration, boolean recovering) {
        if (!ownsHostListener(listener)) return;
        if (!recovering && hostRetry != null) return;
        if (hostRetry != null) main.removeCallbacks(hostRetry);
        hostRetry = () -> {
            hostRetry = null;
            if (!ownsHostListener(listener)) return;
            if (attempt != null && !BotHostService.ownsAttempt(attempt)) return;
            if (failedGeneration != null && !BotHostManager.get(this).isCurrentFailure(failedGeneration)) return;
            Log.i("BotClientService", recovering ? "Retrying Host after child exit" : "Retrying Host after connection recovery");
            BotHostService.recover(listener, recovering);
        };
        main.postDelayed(hostRetry, 5000);
    }

    static CompletableFuture<JSONObject> saveHostCenterSettings(Context context, JSONObject input) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        BotClientService service = activeService;
        if (service == null) {
            try { result.complete(BotHostManager.get(context).saveCenterSettings(input)); }
            catch (Exception failure) { result.completeExceptionally(failure); }
            return result;
        }
        int epoch = service.lifecycle.get();
        service.main.post(() -> service.saveHostCenterSettings(input, result, epoch));
        return result;
    }

    private void saveHostCenterSettings(JSONObject input, CompletableFuture<JSONObject> result, int epoch) {
        if (!alive || lifecycle.get() != epoch || activeService != this || hostExitListener == null) {
            result.completeExceptionally(new IllegalStateException("客户端已关闭或配置正在更新"));
            return;
        }
        BotHostManager manager = BotHostManager.get(this);
        String phase = manager.snapshot().optString("phase");
        boolean wasRunning = "running".equals(phase) || "starting".equals(phase);
        detachHostListener();
        manager.stop().whenComplete((ignored, stopError) -> main.post(() -> {
            if (!alive || lifecycle.get() != epoch || activeService != this) {
                result.completeExceptionally(new IllegalStateException("客户端已关闭"));
                return;
            }
            if (stopError != null) {
                attachHostListener();
                result.completeExceptionally(stopError);
                return;
            }
            try {
                JSONObject saved = manager.saveCenterSettings(input);
                attachHostListener();
                BotHostService.startForClient(this);
                result.complete(saved);
            } catch (Exception failure) {
                attachHostListener();
                if (wasRunning && manager.centerSettingsConfirmed()) BotHostService.startForClient(this);
                result.completeExceptionally(failure);
            }
        }));
    }

    static void requestPoll() {
        BotClientService service = activeService;
        if (service == null || !service.alive) return;
        service.main.post(() -> {
            if (!service.alive) return;
            service.main.removeCallbacks(service.check);
            if (service.polling) service.rescanRequested = true;
            else service.main.post(service.check);
        });
    }

    @Override public void onCreate() {
        super.onCreate();
        activeService = this;
        NotificationManager notifications = getSystemService(NotificationManager.class);
        NotificationChannel connectionChannel = new NotificationChannel(CHANNEL, "中心连接", NotificationManager.IMPORTANCE_LOW);
        connectionChannel.setSound(null, null);
        connectionChannel.enableVibration(false);
        notifications.createNotificationChannel(connectionChannel);
        notifications.createNotificationChannel(new NotificationChannel("bot-client-tasks", "任务完成", NotificationManager.IMPORTANCE_DEFAULT));
        startForeground(NOTIFICATION_ID, notification("客户端运行中"));
        Thread cleanup = new Thread(() -> LegacySystemCleanup.run(this), "obsolete-system-cleanup");
        cleanup.setDaemon(true);
        cleanup.start();
        connectivity = getSystemService(ConnectivityManager.class);
        connectivity.registerDefaultNetworkCallback(network);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_EXIT.equals(intent.getAction())) {
            if (exitCleanup == null || exitCleanup.isDone()) beginExit();
            else sendBroadcast(new Intent(ACTION_CLOSE_UI).setPackage(getPackageName()));
            return START_NOT_STICKY;
        }
        if (exitCleanup != null) {
            sendBroadcast(new Intent(ACTION_CLOSE_UI).setPackage(getPackageName()));
            return START_NOT_STICKY;
        }
        if (!alive) {
            polling = false;
            scanHasPending = false;
            rescanRequested = false;
            alive = true;
            lifecycle.incrementAndGet();
            Log.i("BotClientService", "Client lifecycle started");
            activeService = this;
            attachHostListener();
            main.post(check);
        }
        if (hostExitListener != null) BotHostService.startForClient(this);
        return START_STICKY;
    }

    private void beginExit() {
        alive = false;
        int epoch = lifecycle.incrementAndGet();
        Log.i("BotClientService", "Client exit requested");
        detachHostListener();
        main.removeCallbacks(check);
        CompletableFuture<Void> clientClosed = BotHostClient.get(this).shutdown();
        BotHostUiBridgeService.closeClientSessions();
        sendBroadcast(new Intent(ACTION_CLOSE_UI).setPackage(getPackageName()));
        updateNotification("正在退出客户端");
        CompletableFuture<Void> hostClosed = BotHostManager.get(this).stop();
        CompletableFuture<Void> cleanup = CompletableFuture.allOf(hostClosed, clientClosed);
        exitCleanup = cleanup;
        cleanup.whenComplete((ignored, error) -> main.post(() -> {
            if (activeService != this || exitCleanup != cleanup || alive || lifecycle.get() != epoch) return;
            if (error != null) {
                Log.e("BotClientService", "Client exit cleanup failed", error);
                updateNotification("退出失败，请再次点击退出客户端");
                return;
            }
            Log.i("BotClientService", "Client exit complete");
            stopService(new Intent(this, BotHostService.class));
            stopForeground(STOP_FOREGROUND_REMOVE);
            exitCleanup = null;
            stopSelf();
        }));
    }

    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, TauriMainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent exit = PendingIntent.getService(this, 0, new Intent(this, BotClientService.class).setAction(ACTION_EXIT),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("AI 客户端")
                .setContentText(text)
                .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel,
                        "退出客户端", exit).build())
                .setCategory(Notification.CATEGORY_SERVICE).build();
    }

    private void updateNotification(String text) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(text));
    }

    @Override public void onDestroy() {
        alive = false;
        lifecycle.incrementAndGet();
        detachHostListener();
        if (activeService == this) activeService = null;
        main.removeCallbacks(check);
        connectivity.unregisterNetworkCallback(network);
        super.onDestroy();
    }

    private void scanPage(JSONObject cursor, int epoch) {
        if (!alive || lifecycle.get() != epoch) return;
        JSONObject options = BotHostUiProtocol.object("limit", 200);
        try { if (cursor != null) options.put("cursor", cursor); } catch (Exception ignored) { }
        BotHostClient.get(this).request("background", () -> alive && lifecycle.get() == epoch, "pending_list",
                BotHostUiProtocol.object("options", options)).whenComplete((envelope, error) -> main.post(() -> {
            if (!alive || lifecycle.get() != epoch) return;
            JSONObject page = envelope == null ? null : envelope.optJSONObject("value");
            if (error != null || page == null) {
                scanHasPending = scanHasPending || previousPending;
                finishScan();
                return;
            }
            scanItem(page.optJSONArray("items"), 0, page.optJSONObject("nextCursor"), epoch);
        }));
    }

    private void finishScan() {
        if (!alive) return;
        polling = false;
        long delay = rescanRequested ? 0 : scanHasPending ? 2000 : 15000;
        rescanRequested = false;
        main.postDelayed(check, delay);
    }

    private void scanItem(JSONArray items, int index, JSONObject cursor, int epoch) {
        if (!alive || lifecycle.get() != epoch) return;
        if (items == null || index >= items.length()) {
            if (cursor != null) scanPage(cursor, epoch);
            else finishScan();
            return;
        }
        JSONObject item = items.optJSONObject(index);
        String state = item == null ? "" : item.optString("state");
        if (item == null || !"primary".equals(item.optString("kind"))
                || !("accepted".equals(state) || "sending".equals(state) || "unconfirmed".equals(state))) {
            scanItem(items, index + 1, cursor, epoch);
            return;
        }
        String deviceId = item.optString("targetDeviceId");
        String botId = item.optString("botId");
        String requestId = item.optString("requestId");
        String key = digest(deviceId + String.valueOf((char) 0) + botId + String.valueOf((char) 0) + requestId);
        if (deviceId.isEmpty() || botId.isEmpty() || requestId.isEmpty()
                || getSharedPreferences("bot_client_notifications", MODE_PRIVATE).getBoolean(key, false)) {
            scanItem(items, index + 1, cursor, epoch);
            return;
        }
        scanHasPending = true;
        JSONObject call = BotHostUiProtocol.object("targetDeviceId", deviceId, "method", "getSubmission",
                "params", BotHostUiProtocol.object("botId", botId, "requestId", requestId));
        BotHostClient.get(this).request("background", () -> alive && lifecycle.get() == epoch, "call", call).whenComplete((envelope, error) -> main.post(() -> {
            if (!alive || lifecycle.get() != epoch) return;
            JSONObject submission = envelope == null ? null : envelope.optJSONObject("value");
            String result = submission == null ? "" : submission.optString("status");
            if (error == null && ("done".equals(result) || "unanswered".equals(result))) {
                showTerminal(this, deviceId, botId, key, "unanswered".equals(result));
            }
            scanItem(items, index + 1, cursor, epoch);
        }));
    }

    private static synchronized boolean showTerminal(Context context, String deviceId, String botId, String key, boolean failed) {
        if (context.getSharedPreferences("bot_client_notifications", MODE_PRIVATE).getBoolean(key, false)) return true;
        if (!isVisible(deviceId, botId)) {
            if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
            Intent intent = new Intent(context, TauriMainActivity.class)
                    .setData(Uri.parse("assistant://bot/" + Uri.encode(deviceId) + "/" + Uri.encode(botId)))
                    .putExtra("assistant_device_id", deviceId).putExtra("assistant_bot_id", botId)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent open = PendingIntent.getActivity(context, 0, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            context.getSystemService(NotificationManager.class).createNotificationChannel(
                    new NotificationChannel("bot-client-tasks", "任务完成", NotificationManager.IMPORTANCE_DEFAULT));
            Notification notification = new Notification.Builder(context, "bot-client-tasks")
                    .setSmallIcon(android.R.drawable.stat_notify_more)
                    .setContentTitle("AI 任务")
                    .setContentText(failed ? "任务未完成" : "任务已完成")
                    .setContentIntent(open).setAutoCancel(true).build();
            try {
                context.getSystemService(NotificationManager.class).notify("bot:" + digest(deviceId + String.valueOf((char) 0) + botId), 3161, notification);
            } catch (SecurityException denied) { return false; }
        }
        context.getSharedPreferences("bot_client_notifications", MODE_PRIVATE).edit().putBoolean(key, true).commit();
        return true;
    }

    static void trackLocalResult(Context context, String deviceId, String botId, String requestId, Throwable failure) {
        if (failure != null && !"unconfirmed".equals(BotHostUiProtocol.errorOutcome(failure))) return;
        if (deviceId.isEmpty() || botId.isEmpty() || requestId.isEmpty()) return;
        String key = digest(deviceId + String.valueOf((char) 0) + botId + String.valueOf((char) 0) + requestId);
        JSONObject value = BotHostUiProtocol.object("deviceId", deviceId, "botId", botId, "requestId", requestId);
        if (context.getSharedPreferences("bot_local_submissions", MODE_PRIVATE).edit().putString(key, value.toString()).commit()) {
            Context app = context.getApplicationContext();
            BotHostService.wakeLocalPolling();
            localHandler.post(() -> pollLocal(app));
        }
    }

    static void pollLocal(Context context) {
        BotHostManager manager = BotHostManager.get(context);
        if (!"running".equals(manager.snapshot().optString("phase")) || !localPolling.compareAndSet(false, true)) return;
        pollLocalItem(context.getApplicationContext(), manager,
                context.getSharedPreferences("bot_local_submissions", MODE_PRIVATE).getAll().entrySet().iterator());
    }

    private static void pollLocalItem(Context context, BotHostManager manager, Iterator<? extends Map.Entry<String, ?>> entries) {
        if (!entries.hasNext() || !"running".equals(manager.snapshot().optString("phase"))) {
            localPolling.set(false);
            return;
        }
        Map.Entry<String, ?> entry = entries.next();
        try {
            JSONObject value = new JSONObject((String) entry.getValue());
            String deviceId = value.getString("deviceId"), botId = value.getString("botId");
            String requestId = value.getString("requestId"), key = entry.getKey();
            manager.call("getSubmission", BotHostUiProtocol.object("botId", botId, "requestId", requestId))
                    .whenComplete((envelope, error) -> {
                        JSONObject submission = envelope == null ? null : envelope.optJSONObject("result");
                        String status = submission == null ? "" : submission.optString("status");
                        if (error == null && ("done".equals(status) || "unanswered".equals(status))
                                && showTerminal(context, deviceId, botId, key, "unanswered".equals(status))) {
                            context.getSharedPreferences("bot_local_submissions", MODE_PRIVATE).edit().remove(key).apply();
                        }
                        localHandler.post(() -> pollLocalItem(context, manager, entries));
                    });
        } catch (Exception ignored) {
            localHandler.post(() -> pollLocalItem(context, manager, entries));
        }
    }

    private static String digest(String text) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder();
            for (byte b : bytes) result.append(String.format("%02x", b & 0xff));
            return result.toString();
        } catch (java.security.NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
