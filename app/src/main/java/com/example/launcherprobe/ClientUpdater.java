package com.example.launcherprobe;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.SystemClock;
import android.util.AtomicFile;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Android 客户端自更新（默认进程）：中心元数据检查 + OkHttp 流式下载 + 私有缓存校验。
 * 凭据只经 {@link BotHostClient#updateCredentials()} 取得（真实 centerReady 且同代才返回），
 * 本类不读跨进程 prefs、不接受网页提供的 URL/token/文件路径。
 * check/download/install 串行在单条 daemon IO 线程；updateStatus/updateCancel 同步快照/取消，
 * 不排队等待下载。安装会话与系统确认由 {@link ClientUpdateInstaller}（独立实现）负责，
 * 其状态在每次 status 中合并，实际已安装版本确认也由其完成。
 */
final class ClientUpdater {

    private static final String PREFS = "client_update";
    private static final String DIR_NAME = "client-update";
    private static final String APK_NAME = "verified.apk";
    private static final String PART_NAME = "verified.apk.part";
    private static final String RELEASE_NAME = "release.json";
    private static final String UPDATE_PATH = "/api/client-updates/android/";
    private static final long AUTO_INTERVAL_MS = 24L * 60 * 60 * 1000;
    private static final long AUTO_RETRY_MS = 60_000;
    private static final long MAX_APK_BYTES = 2L * 1024 * 1024 * 1024;
    private static final int MAX_META_BYTES = 256 * 1024;
    private static final int MAX_NOTES = 32 * 1024;
    static final long PROGRESS_BROADCAST_INTERVAL_MS = 120L;
    static final int MAX_HTTP_CLIENTS = 4;

    private static final Object HTTP_CLIENTS_LOCK = new Object();
    private static final LinkedHashMap<String, OkHttpClient> HTTP_CLIENTS =
            new LinkedHashMap<>(8, 0.75f, true);

    private static volatile ClientUpdater instance;

    private final Context context;
    private final SharedPreferences prefs;
    private final Environment env;
    private final Object lock = new Object();
    private final AtomicBoolean automaticCheckQueued = new AtomicBoolean();
    private final Executor io;

    // 以下状态字段均由 lock 保护；downloadedBytes/totalBytes 供 IO 线程写进度，故 volatile。
    private String phase = "idle";
    private JSONObject release;
    private String message;
    private volatile long downloadedBytes;
    private volatile long totalBytes;
    private long epoch;
    private Active active;
    private boolean restored;
    private boolean identityRead;
    private String versionName = "";
    private long installedVersionCode;
    private String abi = "";
    private Long knownGeneration;
    private boolean installerInvalidated;
    private boolean pendingAutomaticCheck;
    private long nextAutomaticCheckAt;

    static final class AppIdentity {
        final String versionName;
        final long versionCode;
        final String abi;

        AppIdentity(String versionName, long versionCode, String abi) {
            this.versionName = versionName == null ? "" : versionName;
            this.versionCode = versionCode;
            this.abi = abi == null ? "" : abi;
        }
    }

    /** 包内可测依赖边界；生产单例始终使用默认真实实现。 */
    interface Environment {
        JSONObject updateCredentials() throws Exception;
        CompletableFuture<JSONObject> confirmUpdateCredentials();
        OkHttpClient httpClient(String caPem);
        long elapsedRealtimeMs();
        AppIdentity readIdentity();
        void verifyPackage(File apk, JSONObject rel, long currentVersionCode) throws Exception;
        JSONObject installerStatus();
        JSONObject installerInstall(File apk, JSONObject publicRelease);
        JSONObject installerCancel();
    }

    /** 下载进度广播节流器：仅在距上次广播 >= 120ms 或整数百分比前进 >= 1% 时触发。 */
    static final class ProgressThrottle {
        private long lastEmitMs;
        private int lastPercent;

        ProgressThrottle(long startMs) {
            this.lastEmitMs = startMs;
            this.lastPercent = 0;
        }

        boolean shouldEmit(long written, long total, long nowMs) {
            int percent = progressPercent(written, total);
            boolean percentAdvanced = percent >= 0 && percent >= lastPercent + 1;
            boolean timeElapsed = nowMs - lastEmitMs >= PROGRESS_BROADCAST_INTERVAL_MS;
            if (!percentAdvanced && !timeElapsed) {
                return false;
            }
            lastEmitMs = nowMs;
            if (percent > lastPercent) {
                lastPercent = percent;
            }
            return true;
        }

        static int progressPercent(long written, long total) {
            if (total <= 0) return -1;
            if (written <= 0) return 0;
            if (written >= total) return 100;
            long pct = written <= Long.MAX_VALUE / 100L
                    ? (written * 100L) / total
                    : (long) (((double) written / (double) total) * 100.0);
            return (int) Math.min(100L, Math.max(0L, pct));
        }
    }

    private static final class Active {
        final long epoch;
        final long generation;
        final boolean restoring;
        final boolean installing;
        volatile boolean cancelled;
        boolean userCancelled;
        volatile Call call;

        Active(long epoch, long generation, boolean restoring, boolean installing) {
            this.epoch = epoch;
            this.generation = generation;
            this.restoring = restoring;
            this.installing = installing;
        }
    }

    private ClientUpdater(Context context) {
        this(context, defaultEnvironment(context.getApplicationContext()), defaultExecutor());
    }

    ClientUpdater(Context context, Environment env, Executor io) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.env = Objects.requireNonNull(env, "env");
        this.io = Objects.requireNonNull(io, "io");
    }

    private static Executor defaultExecutor() {
        return new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(2), runnable -> {
                    Thread thread = new Thread(runnable, "client-update-io");
                    thread.setDaemon(true);
                    return thread;
                });
    }

    private static Environment defaultEnvironment(Context appContext) {
        return new Environment() {
            @Override public JSONObject updateCredentials() throws Exception {
                return BotHostClient.get(appContext).updateCredentials();
            }
            @Override public CompletableFuture<JSONObject> confirmUpdateCredentials() {
                return BotHostClient.get(appContext).confirmUpdateCredentials();
            }
            @Override public OkHttpClient httpClient(String caPem) {
                return ClientUpdater.httpClient(caPem);
            }
            @Override public long elapsedRealtimeMs() {
                return SystemClock.elapsedRealtime();
            }
            @Override public AppIdentity readIdentity() {
                String name = "";
                long code = 0;
                try {
                    PackageInfo info = appContext.getPackageManager().getPackageInfo(appContext.getPackageName(), 0);
                    name = info.versionName == null ? "" : info.versionName;
                    code = info.getLongVersionCode();
                } catch (Exception failure) {
                    name = "";
                    code = 0;
                }
                String[] supported = Build.SUPPORTED_ABIS;
                String first = supported != null && supported.length > 0 ? supported[0] : "";
                String arch;
                if (first.contains("arm64")) arch = "aarch64";
                else if (first.contains("x86_64")) arch = "x86_64";
                else arch = "";
                return new AppIdentity(name, code, arch);
            }
            @Override public void verifyPackage(File apk, JSONObject rel, long currentVersionCode) throws Exception {
                PackageInfo archived = appContext.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
                if (archived == null || !appContext.getPackageName().equals(archived.packageName)) {
                    throw new IllegalArgumentException("无法读取安装包或包名不符");
                }
                if (currentVersionCode <= 0 || archived.getLongVersionCode() != rel.getLong("versionCode")
                        || archived.getLongVersionCode() <= currentVersionCode) {
                    throw new IllegalArgumentException("安装包版本号不符");
                }
                if (!rel.getString("version").equals(archived.versionName)) {
                    throw new IllegalArgumentException("安装包版本不符");
                }
            }
            @Override public JSONObject installerStatus() {
                return ClientUpdateInstaller.status(appContext);
            }
            @Override public JSONObject installerInstall(File apk, JSONObject publicRelease) {
                return ClientUpdateInstaller.install(appContext, apk, publicRelease);
            }
            @Override public JSONObject installerCancel() {
                return ClientUpdateInstaller.cancel(appContext);
            }
        };
    }

    /** 默认进程内唯一管理器：冷状态只构造，不读凭据、不触网。 */
    static ClientUpdater get(Context context) {
        if (instance == null) {
            synchronized (ClientUpdater.class) {
                if (instance == null) instance = new ClientUpdater(context);
            }
        }
        return instance;
    }

    /** 固定入口：updateStatus/updateCheck/updateDownload/updateInstall/updateCancel。 */
    CompletableFuture<JSONObject> request(String method, JSONObject params) {
        if (method == null) return failed(invalidArg("method 无效"));
        try {
            switch (method) {
                case "updateStatus":
                    if (params != null && params.length() != 0) return failed(invalidArg("updateStatus 无输入"));
                    return CompletableFuture.completedFuture(statusWithInstaller());
                case "updateCheck":
                    return check(params);
                case "updateDownload":
                    return download(params);
                case "updateInstall":
                    return install(params);
                case "updateCancel":
                    if (params != null && params.length() != 0) return failed(invalidArg("updateCancel 无输入"));
                    return CompletableFuture.completedFuture(cancelUpdate());
                default:
                    return failed(invalidArg("不支持的更新方法"));
            }
        } catch (Exception failure) {
            return failed(failure);
        }
    }

    // ---------- 状态 ----------

    /** 恢复校验在 IO 线程执行；状态查询不等待下载或安装包校验。 */
    private JSONObject statusWithInstaller() throws Exception {
        long statusEpoch;
        synchronized (lock) {
            JSONObject creds = currentCredentialsLocked();
            if (creds != null) ensureRestoredLocked(creds);
            if (creds == null || !mayShowInstallerLocked(creds) || active != null) {
                return statusSnapshotLocked();
            }
            statusEpoch = epoch;
        }
        JSONObject installer = env.installerStatus();
        synchronized (lock) {
            JSONObject creds = currentCredentialsLocked();
            JSONObject out = statusSnapshotLocked();
            if (creds != null && active == null && statusEpoch == epoch && mayShowInstallerLocked(creds)) {
                mergeInstaller(out, installer);
                phase = out.optString("phase", phase);
                message = out.optString("message", null);
            }
            return out;
        }
    }

    private boolean mayShowInstallerLocked(JSONObject creds) throws Exception {
        return !installerInvalidated
                && originOf(creds.getString("url")).equals(prefs.getString("installerOrigin", ""))
                && creds.getString("deviceId").equals(prefs.getString("installerDeviceId", ""))
                && ("idle".equals(phase) || "waiting-permission".equals(phase)
                    || "waiting-install".equals(phase) || "installing".equals(phase)
                    || "complete".equals(phase) || "cancelled".equals(phase));
    }

    /** 安装器只可覆盖公共状态字段，绝不转发内部路径、URL 或凭据。 */
    private static void mergeInstaller(JSONObject out, JSONObject installer) {
        if (installer == null) return;
        String p = installer.optString("phase", "");
        if (!"waiting-permission".equals(p) && !"waiting-install".equals(p)
                && !"installing".equals(p) && !"complete".equals(p)
                && !"cancelled".equals(p) && !"error".equals(p)) return;
        try {
            out.put("phase", p);
            if (installer.has("message")) out.put("message", installer.opt("message"));
            JSONObject rel = installer.optJSONObject("release");
            if (rel != null) out.put("release", publicRelease(rel));
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private JSONObject statusSnapshotLocked() {
        ensureIdentityLocked();
        JSONObject out = new JSONObject();
        try {
            out.put("phase", phase);
            out.put("currentVersion", versionName);
            if (release != null && ("available".equals(phase) || "downloading".equals(phase)
                    || "downloaded".equals(phase) || "waiting-permission".equals(phase)
                    || "waiting-install".equals(phase) || "installing".equals(phase))) {
                out.put("release", publicRelease(release));
            }
            if ("downloading".equals(phase) || "downloaded".equals(phase)) {
                out.put("downloadedBytes", downloadedBytes);
                if (totalBytes > 0) out.put("totalBytes", totalBytes);
                else out.put("totalBytes", JSONObject.NULL);
            }
            if (message != null && !message.isEmpty()) out.put("message", message);
        } catch (JSONException impossible) {
        }
        return out;
    }

    /** 对外只暴露协议字段；内部 url/_generation 等不外泄。 */
    private static JSONObject publicRelease(JSONObject rel) {
        JSONObject out = new JSONObject();
        String[] keys = {"id", "version", "notes", "size", "sha256", "versionCode", "sourceCommit"};
        for (String key : keys) {
            if (rel.has(key)) {
                try {
                    out.put(key, rel.opt(key));
                } catch (JSONException ignored) {
                }
            }
        }
        return out;
    }

    /** 失效时取消旧工作，但保留占位直到 IO 线程退出，避免无界排队。 */
    private void resetLocked() {
        epoch++;
        if (active != null) {
            active.cancelled = true;
            if (active.call != null) active.call.cancel();
        }
        phase = "idle";
        release = null;
        message = null;
        downloadedBytes = 0;
        totalBytes = 0;
        restored = false;
        nextAutomaticCheckAt = 0;
        knownGeneration = null;
        installerInvalidated = true;
        deleteArtifacts();
    }

    /** 调用方持 lock：断开和代次变化均立即废弃旧结果。 */
    private JSONObject currentCredentialsLocked() {
        try {
            JSONObject creds = credentials();
            long generation = creds.getLong("generation");
            if (knownGeneration != null && knownGeneration.longValue() != generation) resetLocked();
            knownGeneration = generation;
            return creds;
        } catch (Exception unavailable) {
            if (knownGeneration != null) resetLocked();
            return null;
        }
    }

    private boolean currentLocked(Active me) {
        return active == me && me.epoch == epoch && !me.cancelled;
    }

    private boolean fenceLocked(Active me) {
        if (!currentLocked(me)) return false;
        JSONObject creds = currentCredentialsLocked();
        return creds != null && currentLocked(me) && creds.optLong("generation") == me.generation;
    }

    /** 慢速 broker 确认只在 IO 线程执行，失败时旧结果一律失效。 */
    private JSONObject confirmActive(Active me) throws Exception {
        synchronized (lock) {
            if (!currentLocked(me)) throw new BridgeException("CANCELLED", "not-sent", "更新操作已失效");
        }
        CompletableFuture<JSONObject> confirmation = null;
        try {
            confirmation = env.confirmUpdateCredentials();
            JSONObject confirmed = confirmation.get(6, TimeUnit.SECONDS);
            synchronized (lock) {
                JSONObject snapshot = currentCredentialsLocked();
                if (!currentLocked(me) || snapshot == null) {
                    throw new BridgeException("CANCELLED", "not-sent", "中心连接已切换");
                }
                if (confirmed.getLong("generation") != me.generation
                        || snapshot.getLong("generation") != me.generation
                        || !originOf(confirmed.getString("url")).equals(originOf(snapshot.getString("url")))
                        || !confirmed.getString("deviceId").equals(snapshot.getString("deviceId"))) {
                    resetLocked();
                    throw new BridgeException("CANCELLED", "not-sent", "中心连接已切换");
                }
            }
            return confirmed;
        } catch (Exception failure) {
            if (confirmation != null) confirmation.cancel(true);
            synchronized (lock) {
                if (currentLocked(me)) resetLocked();
            }
            throw failure;
        }
    }

    private void finish(Active me) {
        boolean checkAgain = false;
        synchronized (lock) {
            if (active == me) {
                active = null;
                checkAgain = pendingAutomaticCheck;
                pendingAutomaticCheck = false;
            }
        }
        if (checkAgain) {
            try {
                check(true);
            } catch (Exception ignored) {
                // 自动检查失败不打断其他操作。
            }
        }
    }

    // ---------- updateCheck ----------

    void checkAutomatically() {
        if (!automaticCheckQueued.compareAndSet(false, true)) return;
        CompletableFuture.runAsync(() -> {
            try {
                if (BotClientService.isActive()) check(true);
            } catch (Exception ignored) {
                // 后台检查失败不打断客户端；下一次轮询会重试。
            } finally {
                automaticCheckQueued.set(false);
            }
        });
    }

    private CompletableFuture<JSONObject> check(JSONObject params) throws Exception {
        boolean automatic = false;
        if (params != null) {
            Iterator<String> keys = params.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!"automatic".equals(key)) return failed(invalidArg("不支持的参数"));
                Object value = params.opt(key);
                if (!(value instanceof Boolean)) return failed(invalidArg("automatic 必须是布尔值"));
                automatic = (Boolean) value;
            }
        }
        return check(automatic);
    }

    private CompletableFuture<JSONObject> check(boolean automatic) throws Exception {
        JSONObject snapshot = null;
        boolean notifyStatusChanged = false;
        boolean notConnected = false;
        synchronized (lock) {
            ensureIdentityLocked();
            String beforePhase = phase;
            JSONObject creds = currentCredentialsLocked();
            if (creds == null) {
                notifyStatusChanged = !Objects.equals(beforePhase, phase);
                if (automatic) {
                    snapshot = statusSnapshotLocked();
                } else {
                    notConnected = true;
                }
            } else if ("waiting-permission".equals(phase) || "waiting-install".equals(phase)
                    || "installing".equals(phase)) {
                return CompletableFuture.completedFuture(statusSnapshotLocked());
            } else {
                if (automatic) {
                    ensureRestoredLocked(creds);
                    if ("downloaded".equals(phase) || "waiting-tasks".equals(phase)) {
                        return CompletableFuture.completedFuture(statusSnapshotLocked());
                    }
                }
                if (active != null && (automatic || !active.restoring)) {
                    if (automatic && active.cancelled) pendingAutomaticCheck = true;
                    if (!automatic && active.cancelled) return failed(new BridgeException("BUSY", "not-sent", "更新操作正在结束"));
                    return CompletableFuture.completedFuture(statusSnapshotLocked());
                }
                if (automatic) {
                    long now = SystemClock.elapsedRealtime();
                    if (now < nextAutomaticCheckAt) {
                        if ("available".equals(phase)) ClientUpdateNotifications.show(context, autoKey(creds), release);
                        return CompletableFuture.completedFuture(statusSnapshotLocked());
                    }
                    long last = prefs.getLong(upToDateKey(creds), 0L);
                    long age = System.currentTimeMillis() - last;
                    if (last > 0 && age >= 0 && age < AUTO_INTERVAL_MS) {
                        nextAutomaticCheckAt = now + AUTO_INTERVAL_MS - age;
                        if ("idle".equals(phase)) {
                            phase = "up-to-date";
                            notifyStatusChanged = true;
                        }
                        snapshot = statusSnapshotLocked();
                    } else {
                        nextAutomaticCheckAt = now + AUTO_RETRY_MS;
                    }
                }
                if (snapshot == null) {
                    if (active != null) {
                        // 新检查取代尚未完成的缓存恢复；最多只排一个后继任务。
                        active.cancelled = true;
                        active = null;
                        restored = false;
                    }
                    String prevPhase = phase;
                    installerInvalidated = true;
                    phase = "checking";
                    message = null;
                    Active me = new Active(++epoch, creds.getLong("generation"), false, false);
                    active = me;
                    io.execute(() -> runCheck(me, automatic, prevPhase));
                    snapshot = statusSnapshotLocked();
                }
            }
        }
        if (notifyStatusChanged) ClientUpdateNotifications.statusChanged(context);
        if (notConnected) return failed(new BridgeException("NOT_CONNECTED", "not-sent", "中心连接未就绪"));
        return CompletableFuture.completedFuture(snapshot);
    }

    private void runCheck(Active me, boolean automatic, String prevPhase) {
        boolean stateChanged = false;
        try {
            JSONObject creds = confirmActive(me);
            final String name;
            final long code;
            final String arch;
            synchronized (lock) {
                if (!fenceLocked(me)) return;
                ensureIdentityLocked();
                name = versionName;
                code = installedVersionCode;
                arch = abi;
            }
            if (name.isEmpty() || code <= 0) throw new IllegalStateException("无法读取当前应用版本");
            if (arch.isEmpty()) throw new IllegalStateException("不支持的设备架构");
            String endpoint = originOf(creds.getString("url")) + UPDATE_PATH + arch + "/apk/"
                    + encodePath(name) + "?versionCode=" + code;
            OkHttpClient client = env.httpClient(creds.optString("ca", ""));
            Request req = new Request.Builder().url(endpoint)
                    .header("Authorization", "Bearer " + creds.getString("deviceToken"))
                    .header("X-Device-Id", creds.getString("deviceId"))
                    .header("Accept", "application/json")
                    .get().build();
            Call call = client.newCall(req);
            me.call = call;
            synchronized (lock) {
                if (!fenceLocked(me)) return;
            }
            if (me.cancelled) call.cancel();
            String newPhase;
            JSONObject rel = null;
            try (Response resp = call.execute()) {
                int status = resp.code();
                if (status == 204) {
                    newPhase = "up-to-date";
                } else if (status == 200) {
                    JSONObject meta = BotHostUiProtocol.parse(readBounded(resp.body(), MAX_META_BYTES));
                    rel = validateRelease(meta, creds, arch);
                    if (rel != null) bindRelease(rel, creds, me.generation);
                    newPhase = rel == null ? "up-to-date" : "available";
                } else {
                    throw new IOException("更新检查失败（HTTP " + status + "）");
                }
            }
            confirmActive(me);
            synchronized (lock) {
                if (!fenceLocked(me)) return;
                phase = newPhase;
                release = rel;
                message = null;
                downloadedBytes = 0;
                totalBytes = rel != null ? rel.optLong("size", 0) : 0;
                restored = true;
                deleteArtifacts();
                stateChanged = true;
                if (automatic) nextAutomaticCheckAt = SystemClock.elapsedRealtime() + AUTO_INTERVAL_MS;
                // 已有更新时不持久化节流，进程重启后要重新查询当前发布，避免通知点开后没有更新可选。
                String key = upToDateKey(creds);
                if (rel == null) {
                    prefs.edit().putLong(key, System.currentTimeMillis()).apply();
                    ClientUpdateNotifications.cancel(context);
                } else {
                    prefs.edit().remove(key).apply();
                    if (automatic && BotClientService.isActive()) {
                        ClientUpdateNotifications.show(context, autoKey(creds), rel);
                    }
                }
            }
        } catch (Exception failure) {
            try {
                confirmActive(me);
            } catch (Exception stale) {
                return;
            }
            synchronized (lock) {
                if (!fenceLocked(me)) return;
                if (automatic) {
                    phase = restorablePhase(prevPhase) ? prevPhase : "idle";
                    message = null;
                } else {
                    phase = "error";
                    message = BotHostUiProtocol.safeMessage(failure);
                    release = null;
                    downloadedBytes = 0;
                    totalBytes = 0;
                }
                stateChanged = true;
            }
        } finally {
            me.call = null;
            boolean invalidated;
            synchronized (lock) {
                invalidated = !stateChanged && (!me.userCancelled || !"cancelled".equals(phase));
            }
            finish(me);
            if (stateChanged || invalidated) {
                ClientUpdateNotifications.statusChanged(context);
            }
        }
    }

    private static boolean restorablePhase(String p) {
        return "idle".equals(p) || "available".equals(p) || "up-to-date".equals(p) || "downloaded".equals(p);
    }

    // ---------- updateDownload ----------

    private CompletableFuture<JSONObject> download(JSONObject params) throws Exception {
        if (params != null && params.length() != 0) return failed(invalidArg("updateDownload 无输入"));
        boolean notifyChanged = false;
        CompletableFuture<JSONObject> result;
        synchronized (lock) {
            String beforePhase = phase;
            JSONObject creds = currentCredentialsLocked();
            notifyChanged = !Objects.equals(beforePhase, phase);
            if (creds == null) {
                result = failed(new BridgeException("NOT_CONNECTED", "not-sent", "中心连接未就绪"));
            } else {
                ensureRestoredLocked(creds);
                if (active != null) result = failed(new BridgeException("BUSY", "not-sent", "更新操作进行中"));
                else if ("downloaded".equals(phase)) result = CompletableFuture.completedFuture(statusSnapshotLocked());
                else if (!"available".equals(phase) || release == null) {
                    result = failed(new BridgeException("INVALID_STATE", "not-sent", "没有可下载的更新"));
                } else {
                    JSONObject rel = release;
                    phase = "downloading";
                    message = null;
                    downloadedBytes = 0;
                    totalBytes = rel.getLong("size");
                    Active me = new Active(++epoch, creds.getLong("generation"), false, false);
                    active = me;
                    io.execute(() -> runDownload(me, rel));
                    result = CompletableFuture.completedFuture(statusSnapshotLocked());
                }
            }
        }
        if (notifyChanged) ClientUpdateNotifications.statusChanged(context);
        return result;
    }

    private void runDownload(Active me, JSONObject rel) {
        File dir = updateDir();
        File part = new File(dir, PART_NAME);
        File apk = new File(dir, APK_NAME);
        boolean stateChanged = false;
        try {
            JSONObject creds = confirmActive(me);
            if (rel.getLong("_generation") != me.generation
                    || !originOf(creds.getString("url")).equals(rel.getString("_origin"))
                    || !creds.getString("deviceId").equals(rel.getString("_deviceId"))) {
                throw new BridgeException("CANCELLED", "not-sent", "中心连接已切换");
            }
            String artifact = resolveArtifactUrl(creds.getString("url"), rel.getString("url"));
            if (artifact == null) throw new IOException("下载地址无效");
            OkHttpClient client = env.httpClient(creds.optString("ca", ""));
            Request req = new Request.Builder().url(artifact)
                    .header("Authorization", "Bearer " + creds.getString("deviceToken"))
                    .header("X-Device-Id", creds.getString("deviceId"))
                    .get().build();
            Call call = client.newCall(req);
            me.call = call;
            synchronized (lock) {
                if (!fenceLocked(me)) return;
                updateDirReady();
                deleteArtifacts();
            }
            if (me.cancelled) call.cancel();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long expectedSize = rel.getLong("size");
            long written = 0;
            try (Response resp = call.execute()) {
                if (resp.code() != 200) throw new IOException("下载失败（HTTP " + resp.code() + "）");
                ResponseBody body = resp.body();
                if (body == null) throw new IOException("下载响应为空");
                ProgressThrottle progressThrottle = new ProgressThrottle(env.elapsedRealtimeMs());
                try (InputStream in = body.byteStream(); FileOutputStream out = new FileOutputStream(part)) {
                    byte[] buffer = new byte[64 * 1024];
                    int count;
                    while ((count = in.read(buffer)) != -1) {
                        if (me.cancelled) throw new IOException("下载已取消");
                        if (count == 0) continue;
                        written += count;
                        if (written > expectedSize || written > MAX_APK_BYTES) throw new IOException("安装包超过大小上限");
                        digest.update(buffer, 0, count);
                        out.write(buffer, 0, count);
                        boolean stillActive;
                        synchronized (lock) {
                            stillActive = currentLocked(me);
                            if (stillActive) downloadedBytes = written;
                        }
                        if (stillActive && progressThrottle.shouldEmit(written, expectedSize, env.elapsedRealtimeMs())) {
                            ClientUpdateNotifications.statusChanged(context);
                        }
                    }
                    out.getFD().sync();
                }
            }
            if (written != expectedSize || !hex(digest.digest()).equalsIgnoreCase(rel.getString("sha256"))) {
                throw new IOException("安装包大小或摘要不符");
            }
            synchronized (lock) {
                if (!fenceLocked(me)) return;
                Files.move(part.toPath(), apk.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
            verifyPackage(apk, rel);
            confirmActive(me);
            synchronized (lock) {
                if (!fenceLocked(me)) return;
                persistRelease(rel);
                phase = "downloaded";
                ClientUpdateNotifications.cancel(context);
                release = rel;
                downloadedBytes = written;
                totalBytes = written;
                message = null;
                restored = true;
                stateChanged = true;
            }
        } catch (Exception failure) {
            try {
                confirmActive(me);
            } catch (Exception stale) {
                return;
            }
            synchronized (lock) {
                if (!fenceLocked(me)) return;
                deleteArtifacts();
                phase = "error";
                message = BotHostUiProtocol.safeMessage(failure);
                release = null;
                downloadedBytes = 0;
                totalBytes = 0;
                stateChanged = true;
            }
        } finally {
            deleteQuietly(part);
            me.call = null;
            boolean invalidated;
            synchronized (lock) {
                invalidated = !stateChanged && (!me.userCancelled || !"cancelled".equals(phase));
            }
            finish(me);
            if (stateChanged || invalidated) {
                ClientUpdateNotifications.statusChanged(context);
            }
        }
    }

    // ---------- updateInstall ----------

    private CompletableFuture<JSONObject> install(JSONObject params) throws Exception {
        if (params != null) {
            Iterator<String> keys = params.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!"stopActive".equals(key)) return failed(invalidArg("不支持的参数"));
                if (!(params.opt(key) instanceof Boolean)) return failed(invalidArg("stopActive 必须是布尔值"));
            }
        }
        boolean notifyChanged = false;
        CompletableFuture<JSONObject> result;
        synchronized (lock) {
            String beforePhase = phase;
            JSONObject creds = currentCredentialsLocked();
            notifyChanged = !Objects.equals(beforePhase, phase);
            if (creds == null) {
                result = failed(new BridgeException("NOT_CONNECTED", "not-sent", "中心连接未就绪"));
            } else {
                ensureRestoredLocked(creds);
                if (active != null) result = failed(new BridgeException("BUSY", "not-sent", "更新操作进行中"));
                else if ((!"downloaded".equals(phase) && !"waiting-permission".equals(phase)) || release == null) {
                    result = failed(new BridgeException("INVALID_STATE", "not-sent", "没有已下载的更新"));
                } else {
                    JSONObject rel = release;
                    Active me = new Active(++epoch, creds.getLong("generation"), false, true);
                    active = me;
                    phase = "installing";
                    message = null;
                    CompletableFuture<JSONObject> pending = new CompletableFuture<>();
                    io.execute(() -> runInstall(me, creds, rel, pending));
                    result = pending;
                }
            }
        }
        if (notifyChanged) ClientUpdateNotifications.statusChanged(context);
        return result;
    }

    private void runInstall(Active me, JSONObject creds, JSONObject rel, CompletableFuture<JSONObject> result) {
        JSONObject response = null;
        Exception error = null;
        boolean invoked = false;
        boolean stateChanged = false;
        try {
            File apk = new File(updateDir(), APK_NAME);
            verifyFile(apk, rel, me);
            verifyPackage(apk, rel);
            confirmActive(me);
            synchronized (lock) {
                if (!fenceLocked(me)) throw new BridgeException("CANCELLED", "not-sent", "中心连接已切换或安装已取消");
                if (!prefs.edit().putString("installerOrigin", originOf(creds.getString("url")))
                        .putString("installerDeviceId", creds.getString("deviceId")).commit()) {
                    throw new IOException("无法保存安装状态");
                }
                installerInvalidated = false;
            }
            if (me.cancelled) throw new BridgeException("CANCELLED", "not-sent", "安装已取消");
            invoked = true;
            JSONObject installed = env.installerInstall(apk, publicRelease(rel));
            confirmActive(me);
            synchronized (lock) {
                if (!fenceLocked(me)) throw new BridgeException("CANCELLED", "not-sent", "中心连接已切换或安装已取消");
                String reported = installed == null ? "" : installed.optString("phase", "");
                if (!"waiting-permission".equals(reported) && !"waiting-install".equals(reported)
                        && !"installing".equals(reported) && !"error".equals(reported)
                        && !"cancelled".equals(reported)) {
                    throw new IllegalStateException("安装器未返回有效状态");
                }
                String prevPhase = phase;
                String prevMessage = message;
                response = statusSnapshotLocked();
                mergeInstaller(response, installed);
                phase = reported;
                message = response.optString("message", null);
                active = null;
                stateChanged = !Objects.equals(prevPhase, phase) || !Objects.equals(prevMessage, message);
            }
        } catch (Exception failure) {
            error = failure;
            try {
                confirmActive(me);
            } catch (Exception stale) {
                // 失败或取消时不能用旧连接的结果覆盖当前状态。
            }
            boolean invalid;
            synchronized (lock) {
                invalid = !fenceLocked(me);
            }
            JSONObject cancelled = null;
            Exception cancelFailure = null;
            if (invalid && invoked) {
                try {
                    cancelled = env.installerCancel();
                } catch (Exception cancelError) {
                    cancelFailure = cancelError;
                }
            }
            synchronized (lock) {
                String prevPhase = phase;
                String prevMessage = message;
                JSONObject current = currentCredentialsLocked();
                if (me.userCancelled && current != null && "installing".equals(phase)
                        && current.optLong("generation") == me.generation) {
                    if (!invoked) {
                        phase = "cancelled";
                        message = null;
                    } else if (cancelFailure != null || cancelled == null) {
                        phase = "error";
                        message = "无法确认安装取消状态";
                    } else {
                        JSONObject out = statusSnapshotLocked();
                        mergeInstaller(out, cancelled);
                        phase = out.optString("phase", "installing");
                        message = out.optString("message", null);
                    }
                } else if (currentLocked(me) && current != null) {
                    phase = "error";
                    message = BotHostUiProtocol.safeMessage(failure);
                }
                stateChanged = !Objects.equals(prevPhase, phase) || !Objects.equals(prevMessage, message);
            }
        } finally {
            boolean invalidated;
            synchronized (lock) {
                invalidated = !stateChanged && !"installing".equals(phase);
            }
            finish(me);
            if (stateChanged || invalidated) {
                ClientUpdateNotifications.statusChanged(context);
            }
        }
        boolean postReset = false;
        if (error == null) {
            synchronized (lock) {
                String prevPhase = phase;
                JSONObject current = currentCredentialsLocked();
                if (current == null || current.optLong("generation") != me.generation || me.epoch != epoch) {
                    error = new BridgeException("CANCELLED", "responded", "中心连接已切换或安装已取消");
                }
                postReset = !Objects.equals(prevPhase, phase);
            }
            if (postReset) ClientUpdateNotifications.statusChanged(context);
        }
        if (error != null) result.completeExceptionally(error);
        else result.complete(response);
    }

    // ---------- updateCancel ----------

    private JSONObject cancelUpdate() throws Exception {
        boolean preparingInstall;
        long cancelEpoch = 0;
        boolean notifyChanged = false;
        JSONObject earlySnapshot = null;
        synchronized (lock) {
            String prevPhase = phase;
            String prevMessage = message;
            JSONObject creds = currentCredentialsLocked();
            preparingInstall = active != null && active.installing;
            if (active != null) {
                boolean current = creds != null && !active.cancelled
                        && creds.getLong("generation") == active.generation;
                active.cancelled = true;
                active.userCancelled = true;
                epoch++;
                if (active.call != null) active.call.cancel();
                if (!preparingInstall && current) {
                    phase = "cancelled";
                    message = null;
                    release = null;
                    downloadedBytes = 0;
                    totalBytes = 0;
                    restored = true;
                    deleteArtifacts();
                }
            }
            if (!Objects.equals(prevPhase, phase) || !Objects.equals(prevMessage, message)) {
                notifyChanged = true;
            }
            if (active != null) {
                earlySnapshot = statusSnapshotLocked();
            } else {
                cancelEpoch = ++epoch;
            }
        }
        if (earlySnapshot != null) {
            if (notifyChanged) ClientUpdateNotifications.statusChanged(context);
            return earlySnapshot;
        }
        JSONObject cancelled = env.installerCancel();
        JSONObject out;
        synchronized (lock) {
            String prevPhase = phase;
            String prevMessage = message;
            JSONObject creds = currentCredentialsLocked();
            out = statusSnapshotLocked();
            if (creds != null && cancelEpoch == epoch && active == null && mayShowInstallerLocked(creds)) {
                mergeInstaller(out, cancelled);
                phase = out.optString("phase", phase);
                message = out.optString("message", null);
            }
            if (!Objects.equals(prevPhase, phase) || !Objects.equals(prevMessage, message)) {
                notifyChanged = true;
            }
        }
        if (notifyChanged) ClientUpdateNotifications.statusChanged(context);
        return out;
    }

    // ---------- 元数据 ----------

    /** 200 体 → 内部 release（含 url/_generation）；返回 null 表示不是更新版本。 */
    private JSONObject validateRelease(JSONObject meta, JSONObject creds, String arch) throws Exception {
        String version = textField(meta, "version", 256);
        String sha = meta.optString("sha256", "");
        if (!sha.matches("(?i)[0-9a-f]{64}")) throw new IllegalArgumentException("更新元数据无效");
        long size = meta.optLong("size", -1);
        if (size <= 0 || size > MAX_APK_BYTES) throw new IllegalArgumentException("更新元数据无效");
        long vc = meta.optLong("versionCode", -1);
        if (vc <= 0) throw new IllegalArgumentException("更新元数据无效");
        String platform = meta.optString("platform", "");
        if (!platform.isEmpty() && !"android".equalsIgnoreCase(platform)) {
            throw new IllegalArgumentException("更新元数据无效");
        }
        String metaArch = meta.optString("arch", "");
        if (!metaArch.isEmpty() && !metaArch.equalsIgnoreCase(arch)) {
            throw new IllegalArgumentException("更新元数据无效");
        }
        String format = meta.optString("format", "");
        if (!format.isEmpty() && !"apk".equalsIgnoreCase(format)) {
            throw new IllegalArgumentException("更新元数据无效");
        }
        String artifact = resolveArtifactUrl(creds.getString("url"), meta.optString("url", ""));
        if (artifact == null) throw new IllegalArgumentException("更新下载地址无效");
        if (vc <= installedVersionCode) return null;
        JSONObject rel = new JSONObject();
        rel.put("version", version);
        rel.put("size", size);
        rel.put("sha256", sha.toLowerCase(Locale.ROOT));
        rel.put("versionCode", vc);
        rel.put("url", artifact);
        putIf(meta, rel, "id", 512);
        putIf(meta, rel, "notes", MAX_NOTES);
        putIf(meta, rel, "sourceCommit", 256);
        putIf(meta, rel, "pub_date", 64);
        putIf(meta, rel, "signature", 4096);
        return rel;
    }

    private static String textField(JSONObject obj, String key, int max) {
        String value = obj.optString(key, "");
        if (value.isEmpty() || value.length() > max) throw new IllegalArgumentException("更新元数据无效");
        return value;
    }

    private static void putIf(JSONObject from, JSONObject to, String key, int max) {
        String value = from.optString(key, "");
        if (value.isEmpty()) return;
        try {
            to.put(key, value.length() > max ? value.substring(0, max) : value);
        } catch (JSONException ignored) {
        }
    }

    // ---------- 凭据与 generation fence ----------

    /** 固定同步凭据接口，只在真实中心连接就绪时返回。 */
    private JSONObject credentials() throws Exception {
        JSONObject creds = env.updateCredentials();
        originOf(creds.getString("url"));
        if (creds.getString("deviceId").isEmpty() || creds.getString("deviceToken").isEmpty()) {
            throw new IllegalStateException("中心凭据不完整");
        }
        creds.getLong("generation");
        return creds;
    }

    private String autoKey(JSONObject creds) throws Exception {
        return sha256Hex(originOf(creds.getString("url")) + "|" + creds.getString("deviceId"));
    }

    private String upToDateKey(JSONObject creds) throws Exception {
        return "up-to-date:" + autoKey(creds) + ":" + installedVersionCode;
    }

    private static void bindRelease(JSONObject rel, JSONObject creds, long generation) throws Exception {
        rel.put("_origin", originOf(creds.getString("url")));
        rel.put("_deviceId", creds.getString("deviceId"));
        rel.put("_generation", generation);
    }

    // ---------- HTTP / TLS ----------

    private static String normalizeCaPem(String caPem) {
        return caPem == null ? "" : caPem.trim();
    }

    /** 复用按规范化 CA PEM 索引的 OkHttpClient（有界 LRU），避免重复 TLS 冷握手。 */
    static OkHttpClient httpClient(String caPem) {
        String key = normalizeCaPem(caPem);
        synchronized (HTTP_CLIENTS_LOCK) {
            OkHttpClient cached = HTTP_CLIENTS.get(key);
            if (cached != null) return cached;
        }
        OkHttpClient created = buildHttpClient(key);
        OkHttpClient result = created;
        OkHttpClient evicted = null;
        synchronized (HTTP_CLIENTS_LOCK) {
            OkHttpClient existing = HTTP_CLIENTS.get(key);
            if (existing != null) {
                result = existing;
            } else {
                HTTP_CLIENTS.put(key, created);
                if (HTTP_CLIENTS.size() > MAX_HTTP_CLIENTS) {
                    Iterator<Map.Entry<String, OkHttpClient>> it = HTTP_CLIENTS.entrySet().iterator();
                    if (it.hasNext()) {
                        evicted = it.next().getValue();
                        it.remove();
                    }
                }
            }
        }
        if (evicted != null) {
            evicted.connectionPool().evictAll();
        }
        return result;
    }

    static void clearHttpClientCacheForTest() {
        List<OkHttpClient> removed;
        synchronized (HTTP_CLIENTS_LOCK) {
            removed = new ArrayList<>(HTTP_CLIENTS.values());
            HTTP_CLIENTS.clear();
        }
        for (OkHttpClient client : removed) {
            client.connectionPool().evictAll();
        }
    }

    /** 自定义 CA 与系统信任库并存；两者均保留证书链和主机名校验。 */
    private static OkHttpClient buildHttpClient(String normalizedCaPem) {
        OkHttpClient.Builder builder = new OkHttpClient.Builder()
                .followRedirects(false)
                .followSslRedirects(false)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS);
        if (!normalizedCaPem.isEmpty()) {
            try {
                CertificateFactory factory = CertificateFactory.getInstance("X.509");
                Collection<? extends Certificate> certs = factory.generateCertificates(
                        new ByteArrayInputStream((normalizedCaPem + "\n").getBytes(StandardCharsets.UTF_8)));
                if (certs.isEmpty()) throw new IllegalArgumentException("空 CA");
                KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
                store.load(null, null);
                int index = 0;
                for (Certificate cert : certs) store.setCertificateEntry("ca-" + index++, cert);
                TrustManagerFactory customFactory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
                customFactory.init(store);
                TrustManagerFactory systemFactory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
                systemFactory.init((KeyStore) null);
                X509TrustManager custom = (X509TrustManager) customFactory.getTrustManagers()[0];
                X509TrustManager system = (X509TrustManager) systemFactory.getTrustManagers()[0];
                X509TrustManager combined = new X509TrustManager() {
                    @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                        system.checkClientTrusted(chain, authType);
                    }
                    @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                        try {
                            system.checkServerTrusted(chain, authType);
                        } catch (CertificateException untrustedBySystem) {
                            custom.checkServerTrusted(chain, authType);
                        }
                    }
                    @Override public X509Certificate[] getAcceptedIssuers() {
                        X509Certificate[] systemIssuers = system.getAcceptedIssuers();
                        X509Certificate[] customIssuers = custom.getAcceptedIssuers();
                        X509Certificate[] all = java.util.Arrays.copyOf(systemIssuers, systemIssuers.length + customIssuers.length);
                        System.arraycopy(customIssuers, 0, all, systemIssuers.length, customIssuers.length);
                        return all;
                    }
                };
                SSLContext ssl = SSLContext.getInstance("TLS");
                ssl.init(null, new javax.net.ssl.TrustManager[]{combined}, new SecureRandom());
                builder.sslSocketFactory(ssl.getSocketFactory(), combined);
            } catch (Exception failure) {
                throw new IllegalStateException("中心 CA 无效", failure);
            }
        }
        return builder.build();
    }

    private static String readBounded(ResponseBody body, int max) throws IOException {
        if (body == null) throw new IOException("空响应");
        try (InputStream in = body.byteStream()) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while ((count = in.read(buffer)) >= 0) {
                total += count;
                if (total > max) throw new IOException("响应过大");
                out.write(buffer, 0, count);
            }
            return out.toString("UTF-8");
        }
    }

    // ---------- URL / 版本 / 文件 ----------

    private static String originOf(String url) {
        HttpUrl parsed = HttpUrl.parse(url);
        if (parsed == null || !"https".equals(parsed.scheme())
                || !parsed.username().isEmpty() || !parsed.password().isEmpty()) {
            throw new IllegalArgumentException("中心地址无效");
        }
        String origin = parsed.newBuilder().encodedPath("/").query(null).fragment(null).build().toString();
        return origin.substring(0, origin.length() - 1);
    }

    /** 使用 OkHttp 的规范化结果比较真实请求目标，认证头发送前必须同源。 */
    private static String resolveArtifactUrl(String centerUrl, String ref) {
        if (ref == null || ref.isEmpty() || ref.length() > 8192) return null;
        try {
            HttpUrl base = HttpUrl.parse(originOf(centerUrl) + "/");
            HttpUrl cand = base.resolve(ref);
            if (cand == null || !cand.username().isEmpty() || !cand.password().isEmpty()
                    || !base.scheme().equals(cand.scheme()) || !base.host().equals(cand.host())
                    || base.port() != cand.port()) return null;
            return cand.toString();
        } catch (IllegalArgumentException failure) {
            return null;
        }
    }

    private static String encodePath(String value) {
        try {
            return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException impossible) {
            throw new AssertionError(impossible);
        }
    }

    private void ensureIdentityLocked() {
        if (identityRead) return;
        identityRead = true;
        AppIdentity id = env.readIdentity();
        versionName = id.versionName;
        installedVersionCode = id.versionCode;
        abi = id.abi;
    }

    private void ensureRestoredLocked(JSONObject creds) throws Exception {
        if (restored || active != null || !"idle".equals(phase)) return;
        ensureIdentityLocked();
        restored = true;
        File dir = updateDir();
        deleteQuietly(new File(dir, PART_NAME));
        if (!new File(dir, APK_NAME).isFile()) return;
        Active me = new Active(++epoch, creds.getLong("generation"), true, false);
        active = me;
        io.execute(() -> restore(me, creds));
    }

    private void restore(Active me, JSONObject creds) {
        try {
            File dir = updateDir();
            File apk = new File(dir, APK_NAME);
            JSONObject stored = readRelease(new File(dir, RELEASE_NAME));
            if (stored == null || !originOf(creds.getString("url")).equals(stored.optString("_origin"))
                    || !creds.getString("deviceId").equals(stored.optString("_deviceId"))) {
                throw new IOException("缓存更新来源不匹配");
            }
            JSONObject rel = validateRelease(stored, creds, abi);
            if (rel == null) throw new IOException("缓存更新版本已过期");
            bindRelease(rel, creds, me.generation);
            verifyFile(apk, rel, me);
            verifyPackage(apk, rel);
            confirmActive(me);
            synchronized (lock) {
                if (!fenceLocked(me)) return;
                release = rel;
                phase = "downloaded";
                downloadedBytes = rel.getLong("size");
                totalBytes = downloadedBytes;
                message = null;
            }
        } catch (Exception failure) {
            try {
                confirmActive(me);
            } catch (Exception stale) {
                return;
            }
            synchronized (lock) {
                if (!fenceLocked(me)) return;
                deleteArtifacts();
            }
        } finally {
            finish(me);
            ClientUpdateNotifications.statusChanged(context);
        }
    }

    private void verifyFile(File apk, JSONObject rel, Active me) throws Exception {
        long size = rel.getLong("size");
        if (!apk.isFile() || apk.length() != size || size <= 0 || size > MAX_APK_BYTES) {
            throw new IOException("缓存安装包大小不符");
        }
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long read = 0;
        try (InputStream in = new FileInputStream(apk)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = in.read(buffer)) != -1) {
                if (me.cancelled) throw new IOException("缓存恢复已取消");
                read += count;
                if (read > size || read > MAX_APK_BYTES) throw new IOException("缓存安装包超过大小上限");
                digest.update(buffer, 0, count);
            }
        }
        if (read != size || !hex(digest.digest()).equalsIgnoreCase(rel.getString("sha256"))) {
            throw new IOException("缓存安装包摘要不符");
        }
    }

    /** APK 签名和覆盖安装关系由 Android 系统安装器最终判定。 */
    private void verifyPackage(File apk, JSONObject rel) throws Exception {
        env.verifyPackage(apk, rel, installedVersionCode);
    }

    private File updateDir() {
        return new File(context.getFilesDir(), DIR_NAME);
    }

    private File updateDirReady() throws IOException {
        File dir = updateDir();
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("无法创建更新目录");
        return dir;
    }

    private void deleteArtifacts() {
        File dir = updateDir();
        deleteQuietly(new File(dir, APK_NAME));
        deleteQuietly(new File(dir, PART_NAME));
        deleteQuietly(new File(dir, RELEASE_NAME));
    }

    private static void deleteQuietly(File file) {
        try {
            if (file != null) file.delete();
        } catch (Throwable ignored) {
        }
    }

    private void persistRelease(JSONObject rel) throws Exception {
        AtomicFile file = new AtomicFile(new File(updateDirReady(), RELEASE_NAME));
        FileOutputStream out = file.startWrite();
        try {
            out.write(rel.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(out);
        } catch (Exception failure) {
            file.failWrite(out);
            throw failure;
        }
    }

    private static JSONObject readRelease(File file) {
        try {
            if (!file.isFile() || file.length() > MAX_META_BYTES) return null;
            return BotHostUiProtocol.parse(
                    new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        } catch (Exception failure) {
            return null;
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        }
        return out.toString();
    }

    private static String sha256Hex(String text) {
        try {
            return hex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }

    private static CompletableFuture<JSONObject> failed(Throwable failure) {
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        future.completeExceptionally(failure);
        return future;
    }

    private static BridgeException invalidArg(String message) {
        return new BridgeException("INVALID_ARGUMENT", "not-sent", message);
    }
}
