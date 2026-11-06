package com.example.launcherprobe;

import android.app.ActivityManager;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Parcel;
import android.os.PowerManager;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;

/** 默认进程的 APK 安装会话；下载和包内容校验由 ClientUpdater 完成。 */
final class ClientUpdateInstaller {
    private static final String PREFS = "client_update_installer";
    private static final String STATE = "state";
    private static final Object LOCK = new Object();
    private static String preparingToken;
    private static String pendingToken;
    private static Intent pendingIntent;

    private ClientUpdateInstaller() {}

    static JSONObject install(Context context, File verifiedApk, JSONObject release) {
        context = context.getApplicationContext();
        final PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        final String token;
        final int sessionId;
        synchronized (LOCK) {
            JSONObject previous = reconcile(context, read(context));
            if (previous != null && active(previous)) {
                if (!"waiting-permission".equals(previous.optString("phase"))) {
                    if (sameRelease(previous, release) && !previous.optBoolean("cancelRequested")) {
                        launchConfirmation(context, previous);
                    }
                    return snapshot(context, previous);
                }
            }

            long expectedCode = release.optLong("versionCode", -1);
            File expectedFile = new File(new File(context.getFilesDir(), "client-update"), "verified.apk");
            try {
                if (!expectedFile.getCanonicalFile().equals(verifiedApk.getCanonicalFile())
                        || !verifiedApk.isFile() || expectedCode <= installed(context).getLongVersionCode()) {
                    throw new IllegalArgumentException("安装包或版本无效");
                }
            } catch (java.io.IOException failure) {
                throw new IllegalArgumentException("安装包不可访问", failure);
            }

            JSONObject state = new JSONObject();
            put(state, "release", publicRelease(release));
            put(state, "expectedCode", expectedCode);
            if (!context.getPackageManager().canRequestPackageInstalls()) {
                put(state, "phase", "waiting-permission");
                put(state, "message", "请允许此应用安装未知应用，然后继续安装");
                save(context, state);
                return snapshot(context, state);
            }

            PackageInstaller.SessionParams params =
                    new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(context.getPackageName());
            params.setSize(verifiedApk.length());
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
            try {
                sessionId = installer.createSession(params);
            } catch (java.io.IOException | RuntimeException failure) {
                put(state, "phase", "error");
                put(state, "message", "无法创建系统安装会话");
                save(context, state);
                return snapshot(context, state);
            }
            token = UUID.randomUUID().toString();
            put(state, "phase", "installing");
            put(state, "message", "正在准备系统安装会话");
            put(state, "sessionId", sessionId);
            put(state, "token", token);
            put(state, "committed", false);
            preparingToken = token;
            try {
                save(context, state);
            } catch (RuntimeException failure) {
                preparingToken = null;
                try {
                    installer.abandonSession(sessionId);
                } catch (RuntimeException ignored) {
                    // No commit was attempted.
                }
                throw failure;
            }
        }

        try (PackageInstaller.Session session = installer.openSession(sessionId);
             InputStream input = new FileInputStream(verifiedApk);
             OutputStream output = session.openWrite("base.apk", 0, verifiedApk.length())) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            session.fsync(output);
        } catch (Exception failure) {
            synchronized (LOCK) {
                JSONObject state = read(context);
                if (matches(state, sessionId, token) && active(state)) {
                    try {
                        installer.abandonSession(sessionId);
                    } catch (RuntimeException ignored) {
                        // No commit was attempted; the old installed app is unchanged.
                    }
                    put(state, "phase", "error");
                    put(state, "message", "准备系统安装会话失败");
                    save(context, state);
                }
                if (token.equals(preparingToken)) preparingToken = null;
                return state == null ? null : snapshot(context, state);
            }
        }

        synchronized (LOCK) {
            JSONObject state = read(context);
            if (!matches(state, sessionId, token) || !active(state)) {
                if (token.equals(preparingToken)) preparingToken = null;
                return state == null ? null : snapshot(context, state);
            }
            PendingIntent result;
            try {
                Intent callback = new Intent(context, ClientUpdateResultReceiver.class)
                        .setAction(context.getPackageName() + ".CLIENT_UPDATE_RESULT")
                        .setData(Uri.parse("client-update:" + token));
                result = PendingIntent.getBroadcast(context, sessionId, callback,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
                put(state, "committed", true);
                put(state, "phase", "waiting-install");
                put(state, "message", "正在等待系统安装确认");
                save(context, state);
            } catch (RuntimeException failure) {
                if (token.equals(preparingToken)) preparingToken = null;
                try {
                    installer.abandonSession(sessionId);
                } catch (RuntimeException ignored) {
                    // No commit was attempted.
                }
                throw failure;
            }
            try (PackageInstaller.Session session = installer.openSession(sessionId)) {
                session.commit(result.getIntentSender());
            } catch (Exception failure) {
                // A failed Binder call does not prove that the system did not accept commit.
                put(state, "message", "系统安装状态尚未确认，可稍后查看或尝试取消");
                save(context, state);
            } finally {
                if (token.equals(preparingToken)) preparingToken = null;
            }
            return snapshot(context, state);
        }
    }

    static JSONObject status(Context context) {
        context = context.getApplicationContext();
        synchronized (LOCK) {
            JSONObject state = reconcile(context, read(context));
            return state == null ? null : snapshot(context, state);
        }
    }

    static JSONObject cancel(Context context) {
        context = context.getApplicationContext();
        synchronized (LOCK) {
            JSONObject state = reconcile(context, read(context));
            if (state == null) {
                JSONObject idle = new JSONObject();
                put(idle, "phase", "idle");
                put(idle, "currentVersion", installed(context).versionName);
                return idle;
            }
            if (!active(state)) return snapshot(context, state);
            int sessionId = state.optInt("sessionId", -1);
            if (sessionId < 0) {
                put(state, "phase", "cancelled");
                state.remove("message");
                save(context, state);
                return snapshot(context, state);
            }
            try {
                context.getPackageManager().getPackageInstaller().abandonSession(sessionId);
                if (state.optBoolean("committed")) {
                    put(state, "cancelRequested", true);
                    put(state, "message", "已请求取消，等待系统确认安装结果");
                } else {
                    put(state, "phase", "cancelled");
                    state.remove("message");
                }
                clearConfirmation(state);
                save(context, state);
            } catch (RuntimeException failure) {
                put(state, "message", "系统未确认取消，安装结果仍待确认");
                save(context, state);
            }
            return snapshot(context, state);
        }
    }

    static void onResult(Context context, Intent result) {
        context = context.getApplicationContext();
        synchronized (LOCK) {
            JSONObject state = read(context);
            int sessionId = result.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
            String token = state == null ? "" : state.optString("token", "");
            if (!matches(state, sessionId, token)
                    || !("client-update:" + token).equals(result.getDataString())
                    || !active(state)) return;

            int code = result.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (code == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                if (state.optBoolean("cancelRequested")) return;
                Intent confirmation = result.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
                if (confirmation == null) {
                    put(state, "message", "系统未提供安装确认，请取消后重试");
                } else {
                    pendingToken = token;
                    pendingIntent = confirmation;
                    put(state, "confirmationReceived", true);
                    String encoded = encodeIntent(confirmation);
                    if (encoded != null) put(state, "confirmation", encoded);
                    put(state, "phase", "waiting-install");
                    put(state, "message", "请在应用中继续并确认安装");
                }
                save(context, state);
                if (confirmation != null) launchConfirmation(context, state);
                return;
            }

            clearConfirmation(state);
            if (code == PackageInstaller.STATUS_SUCCESS) {
                put(state, "phase", "installing");
                put(state, "message", "系统已处理安装，等待已安装版本确认");
            } else if (code == PackageInstaller.STATUS_FAILURE_ABORTED) {
                put(state, "phase", "cancelled");
                put(state, "message", "系统安装已取消，原应用和数据保留");
            } else {
                put(state, "phase", "error");
                put(state, "message", failureMessage(code));
            }
            save(context, state);
            reconcile(context, state);
        }
    }

    private static JSONObject reconcile(Context context, JSONObject state) {
        if (state == null) return null;
        if (state.optBoolean("committed") && state.optLong("expectedCode", -1) > 0
                && installed(context).getLongVersionCode() >= state.optLong("expectedCode")) {
            if (!"complete".equals(state.optString("phase"))) {
                clearConfirmation(state);
                put(state, "phase", "complete");
                put(state, "message", "已确认安装更新");
                save(context, state);
            }
        } else if (active(state) && state.has("sessionId") && !state.optBoolean("committed")
                && !state.optString("token").equals(preparingToken)) {
            try {
                context.getPackageManager().getPackageInstaller().abandonSession(state.optInt("sessionId"));
            } catch (RuntimeException ignored) {
                // No commit was attempted for this interrupted preparation.
            }
            put(state, "phase", "error");
            put(state, "message", "安装准备被中断，请重试");
            save(context, state);
        }
        return state;
    }

    private static void launchConfirmation(Context context, JSONObject state) {
        if (!"waiting-install".equals(state.optString("phase")) || !uiVisible(context)) return;
        String token = state.optString("token");
        Intent confirmation = token.equals(pendingToken) ? pendingIntent : decodeIntent(state.optString("confirmation"));
        if (confirmation == null) {
            put(state, "message", state.optBoolean("confirmationReceived")
                    ? "无法恢复系统确认，请取消后重试" : "正在等待系统安装确认");
            save(context, state);
            return;
        }
        try {
            context.startActivity(new Intent(confirmation).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (RuntimeException failure) {
            put(state, "message", "无法打开系统确认，请返回应用后重试");
            save(context, state);
        }
    }

    private static boolean uiVisible(Context context) {
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        PowerManager power = context.getSystemService(PowerManager.class);
        if (keyguard.isKeyguardLocked() || !power.isInteractive()) return false;
        ActivityManager activities = context.getSystemService(ActivityManager.class);
        for (ActivityManager.AppTask task : activities.getAppTasks()) {
            ActivityManager.RecentTaskInfo info = task.getTaskInfo();
            if (info != null && info.isVisible() && info.topActivity != null
                    && TauriMainActivity.class.getName().equals(info.topActivity.getClassName())) {
                return true;
            }
        }
        return false;
    }

    // shortcut: Parcel 仅用于短期恢复待确认 Intent；系统升级后不能恢复时取消会话并重试。
    private static String encodeIntent(Intent intent) {
        Parcel parcel = Parcel.obtain();
        try {
            intent.writeToParcel(parcel, 0);
            return Base64.encodeToString(parcel.marshall(), Base64.NO_WRAP);
        } catch (RuntimeException failure) {
            return null;
        } finally {
            parcel.recycle();
        }
    }

    private static Intent decodeIntent(String encoded) {
        if (encoded.isEmpty()) return null;
        Parcel parcel = Parcel.obtain();
        try {
            byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
            parcel.unmarshall(bytes, 0, bytes.length);
            parcel.setDataPosition(0);
            return Intent.CREATOR.createFromParcel(parcel);
        } catch (RuntimeException failure) {
            return null;
        } finally {
            parcel.recycle();
        }
    }

    private static void clearConfirmation(JSONObject state) {
        if (state.optString("token").equals(pendingToken)) {
            pendingToken = null;
            pendingIntent = null;
        }
        state.remove("confirmation");
    }

    private static boolean active(JSONObject state) {
        String phase = state.optString("phase");
        return "waiting-permission".equals(phase) || "waiting-install".equals(phase)
                || "installing".equals(phase);
    }

    private static boolean matches(JSONObject state, int sessionId, String token) {
        return state != null && sessionId >= 0 && !token.isEmpty()
                && state.optInt("sessionId", -1) == sessionId && token.equals(state.optString("token"));
    }

    private static boolean sameRelease(JSONObject state, JSONObject release) {
        JSONObject old = state.optJSONObject("release");
        return old != null && old.optString("id").equals(release.optString("id"))
                && state.optLong("expectedCode", -1) == release.optLong("versionCode", -2);
    }

    private static JSONObject publicRelease(JSONObject release) {
        JSONObject copy = new JSONObject();
        for (String key : new String[] { "id", "version", "notes", "size", "sha256", "versionCode", "sourceCommit" }) {
            if (release.has(key)) put(copy, key, release.opt(key));
        }
        return copy;
    }

    private static JSONObject snapshot(Context context, JSONObject state) {
        JSONObject result = new JSONObject();
        put(result, "phase", state.optString("phase"));
        put(result, "currentVersion", installed(context).versionName);
        if (state.has("release")) put(result, "release", state.optJSONObject("release"));
        if (state.has("message")) put(result, "message", state.optString("message"));
        return result;
    }

    private static PackageInfo installed(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        } catch (android.content.pm.PackageManager.NameNotFoundException failure) {
            throw new IllegalStateException("无法读取已安装版本", failure);
        }
    }

    private static JSONObject read(Context context) {
        String value = prefs(context).getString(STATE, null);
        if (value == null) return null;
        try {
            return new JSONObject(value);
        } catch (JSONException failure) {
            throw new IllegalStateException("安装状态无法读取", failure);
        }
    }

    private static void save(Context context, JSONObject state) {
        if (!prefs(context).edit().putString(STATE, state.toString()).commit()) {
            throw new IllegalStateException("安装状态无法保存");
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (JSONException failure) {
            throw new IllegalStateException("安装状态无效", failure);
        }
    }

    private static String failureMessage(int code) {
        switch (code) {
            case PackageInstaller.STATUS_FAILURE_BLOCKED:
                return "系统阻止了安装，原应用和数据保留";
            case PackageInstaller.STATUS_FAILURE_CONFLICT:
                return "安装包与已安装应用冲突，原应用和数据保留";
            case PackageInstaller.STATUS_FAILURE_INCOMPATIBLE:
                return "安装包与设备不兼容，原应用和数据保留";
            case PackageInstaller.STATUS_FAILURE_INVALID:
                return "系统认为安装包无效，原应用和数据保留";
            case PackageInstaller.STATUS_FAILURE_STORAGE:
                return "存储空间不足，原应用和数据保留";
            default:
                return "系统安装失败，原应用和数据保留";
        }
    }
}
