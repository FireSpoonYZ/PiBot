package com.example.launcherprobe;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import org.json.JSONObject;

import moe.shizuku.api.BinderContainer;
import rikka.shizuku.Shizuku;
import rikka.shizuku.ShizukuProvider;

/**
 * Onboarding 状态/动作桥：全部在 :tauri_ui 进程本地执行，不启动 Host/FGS/Agent。
 *
 * Shizuku API 依赖的 binder 只会投递给默认进程的 ShizukuProvider（multiprocess 必须为 false）。
 * 这里通过 provider 的 getBinder call 把默认进程持有的 binder 拉到本进程
 * （ShizukuProvider 内置的多进程支持，等价 requestBinderForNonProviderProcess 的拉取部分，
 * 按需重复拉取而不注册常驻接收器），随后即可在本进程使用
 * Shizuku.pingBinder/checkSelfPermission/requestPermission。
 */
final class BotOnboarding {

    static final String SHIZUKU_PACKAGE = "moe.shizuku.privileged.api";
    /** Shizuku 权限请求码；结果不经 OnRequestPermissionResultListener，状态靠再次查询。 */
    private static final int SHIZUKU_REQUEST_CODE = 0x4F42;
    private static final int NOTIFICATIONS_REQUEST_CODE = 0x4E46;
    private static final String BINDER_EXTRA = "moe.shizuku.privileged.api.intent.extra.BINDER";

    private BotOnboarding() {
    }

    /** 只读状态查询：不启动任何服务，不触发权限弹窗。 */
    static JSONObject status(Context context) {
        boolean running = ensureShizukuBinder(context) && Shizuku.pingBinder();
        boolean granted = false;
        if (running) {
            try {
                granted = Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
            } catch (RuntimeException unavailable) {
                granted = false;
            }
        }
        try {
            return new JSONObject()
                    .put("notificationsGranted", notificationsGranted(context))
                    .put("batteryUnrestricted", batteryUnrestricted(context))
                    .put("shizukuInstalled", shizukuInstalled(context))
                    .put("shizukuRunning", running)
                    .put("shizukuGranted", granted);
        } catch (org.json.JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /**
     * 显式前台动作；成功发出系统请求/页面返回 {requested:true}，
     * 无法发出（Shizuku 未运行/未装、系统页打不开）抛 UNAVAILABLE——UI 需要明确错误而非静默 false。
     * {requested} 只表示已发出，不代表用户已授予。
     */
    static JSONObject performAction(Activity activity, String action) throws BridgeException {
        switch (action) {
            case "notifications":
                requestNotifications(activity);
                break;
            case "battery-settings":
                openSettings(activity,
                        new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                        "无法打开电池优化设置页");
                break;
            case "shizuku-permission":
                requestShizukuPermission(activity);
                break;
            case "shizuku-manager":
                openShizukuManager(activity);
                break;
            default:
                throw new BridgeException("INVALID_ARGS", "not-sent", "action 无效");
        }
        try {
            return new JSONObject().put("requested", true);
        } catch (org.json.JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    // minSdk 33：运行时 POST_NOTIFICATIONS 是主路径；已授权但通知被关（areNotificationsEnabled=false）
    // 时只能打开应用通知设置页让用户恢复。
    private static void requestNotifications(Activity activity) throws BridgeException {
        if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    NOTIFICATIONS_REQUEST_CODE);
            return;
        }
        if (!notificationsGranted(activity)) {
            openSettings(activity,
                    new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName()),
                    "无法打开应用通知设置");
        }
    }

    private static void requestShizukuPermission(Activity activity) throws BridgeException {
        if (!ensureShizukuBinder(activity) || !Shizuku.pingBinder()) {
            throw new BridgeException("UNAVAILABLE", "not-sent", "Shizuku 未运行，无法请求权限");
        }
        try {
            if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) return;
            Shizuku.requestPermission(SHIZUKU_REQUEST_CODE);
        } catch (RuntimeException unavailable) {
            throw new BridgeException("UNAVAILABLE", "not-sent", "无法请求 Shizuku 权限");
        }
    }

    private static void openShizukuManager(Activity activity) throws BridgeException {
        Intent intent = activity.getPackageManager().getLaunchIntentForPackage(SHIZUKU_PACKAGE);
        if (intent == null) {
            throw new BridgeException("UNAVAILABLE", "not-sent", "未安装 Shizuku 管理器");
        }
        openSettings(activity, intent, "无法打开 Shizuku 管理器");
    }

    private static void openSettings(Activity activity, Intent intent, String message)
            throws BridgeException {
        try {
            activity.startActivity(intent);
        } catch (RuntimeException missing) {
            throw new BridgeException("UNAVAILABLE", "not-sent", message);
        }
    }

    private static boolean notificationsGranted(Context context) {
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        return manager != null && manager.areNotificationsEnabled();
    }

    private static boolean batteryUnrestricted(Context context) {
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    private static boolean shizukuInstalled(Context context) {
        try {
            context.getPackageManager().getPackageInfo(SHIZUKU_PACKAGE,
                    PackageManager.PackageInfoFlags.of(0));
            return true;
        } catch (PackageManager.NameNotFoundException missing) {
            return false;
        }
    }

    /**
     * 本进程没有 ShizukuProvider 实例：向默认进程的 provider 拉取当前 binder。
     * 已存活直接返回；拉到新 binder 后交给 Shizuku.onBinderReceived 完成本进程 attach。
     */
    private static boolean ensureShizukuBinder(Context context) {
        if (Shizuku.pingBinder()) return true;
        try {
            Bundle reply = context.getContentResolver().call(
                    Uri.parse("content://" + context.getPackageName() + ".shizuku"),
                    ShizukuProvider.METHOD_GET_BINDER, null, new Bundle());
            if (reply == null) return false;
            reply.setClassLoader(BinderContainer.class.getClassLoader());
            BinderContainer container = reply.getParcelable(BINDER_EXTRA, BinderContainer.class);
            if (container == null || container.binder == null) return false;
            Shizuku.onBinderReceived(container.binder, context.getPackageName());
            return true;
        } catch (RuntimeException failure) {
            return false;
        }
    }
}
