package com.example.launcherprobe;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * M20 Android 独立客户端子进程：复用 libnode_launcher/BotHostProcess，以 mode=client 懒启动
 * 桌面 broker（openDesktopClient），dataRoot 固定 files/bot-client，与 files/bot-host 隔离。
 * 只转发固定 broker 操作；本机 Host 由客户端前台服务管理，不发 native 工具调用。
 * 单写者：应用内共享同一 broker，UI 只拥有观察；不重放业务变更。
 * 进程占有权按默认进程共享（{@link #get}）：Bound Service 重建不会重置上一代的
 * starting/closing 状态，只有确认退出才允许下一代启动。
 */
final class BotHostClient {

    /** 与 Host 状态目录隔离的客户端根（profiles/drafts/pending 都在其下）。 */
    private static final String DATA_ROOT = "bot-client";
    private static final int CONTROL_QUEUE_CAPACITY = 8;
    private static final Object INSTANCE_LOCK = new Object();
    private static BotHostClient instance;

    private final Context context;
    private final Object lock = new Object();
    private final CenterClientCredentials credentials;
    private long centerRevision;
    private boolean centerPending;
    private boolean centerBlocked;
    private boolean centerReadyObserved;
    private boolean restoreNeeded = true;
    private boolean restoreQueued;
    private JSONObject pendingCredentials;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable pendingStatus = new Runnable() {
        @Override public void run() {
            synchronized (lock) {
                if (!BotClientService.isActive() || pendingCredentials == null || centerBlocked) return;
                if (generation == null) {
                    restore();
                    main.postDelayed(this, 5000);
                    return;
                }
                if (generation.closing) {
                    main.postDelayed(this, 5000);
                    return;
                }
            }
            checkStatus()
                    .whenComplete((v, e) -> {
                        synchronized (lock) {
                            if (pendingCredentials != null && !centerBlocked)
                                main.postDelayed(this, 5000);
                        }
                    });
        }
    };
    /** 串行化启动/关闭与帧派发；读响应不占用本线程。 */
    private final ThreadPoolExecutor control;

    /** 唯一一代客户端进程；从启动占位起占有，只有真实 onExit 才清空。 */
    private Generation generation;
    private final Map<String, ClientObservation> clientObservations = new HashMap<>();

    private static final class ClientObservation {
        final String owner;
        final BotHostProcess process;
        ClientObservation(String owner, BotHostProcess process) { this.owner = owner; this.process = process; }
    }

    /** 默认进程内唯一的管理器：冷状态只构造（不启动 Node、不准备资产）。 */
    static BotHostClient get(Context context) {
        synchronized (INSTANCE_LOCK) {
            if (instance == null) instance = new BotHostClient(context);
            return instance;
        }
    }

    private BotHostClient(Context context) {
        this.context = context.getApplicationContext();
        this.credentials = new CenterClientCredentials(this.context);
        this.control = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(CONTROL_QUEUE_CAPACITY),
                runnable -> {
                    Thread thread = new Thread(runnable, "bot-client-control");
                    thread.setDaemon(true);
                    return thread;
                },
                new ThreadPoolExecutor.AbortPolicy());
    }

    /**
     * 一代客户端进程：process 在 onStarting 时填入；current=已就绪并被 owner 使用，
     * closing=关闭已发起（等 onExit 才解除占有），owner=启动占位时即确定的持有会话。
     */
    private static final class Generation {
        final String owner;
        BotHostProcess process;
        boolean current;
        boolean closing;
        final CompletableFuture<Void> closeDone = new CompletableFuture<>();

        Generation(String owner) {
            this.owner = owner;
        }
    }

    /**
     * 固定 broker 操作（唯一入口由 Node client 模式再校验 16 项白名单）。返回
     * {value:&lt;broker 结果&gt;}，null/数组原样保留；不重放、不二次包装原始错误。
     */
    CompletableFuture<JSONObject> request(String ownerId, BooleanSupplier ownerOpen, String op, JSONObject params) {
        return request(ownerId, ownerOpen, op, params, null);
    }

    private CompletableFuture<JSONObject> request(String ownerId, BooleanSupplier ownerOpen, String op,
                                                   JSONObject params, Long backgroundRevision) {
        final JSONObject input = params == null ? new JSONObject() : params;
        return onControl(() -> {
            if (backgroundRevision != null) synchronized (lock) {
                if (centerBlocked || backgroundRevision.longValue() != centerRevision)
                    throw new BridgeException("CANCELLED", "not-sent", "后台连接已停止");
            }
            BotHostProcess process = acquire(ownerId, ownerOpen);
            if (!ownerOpen.getAsBoolean()) throw new BridgeException("CANCELLED", "not-sent", "客户端已关闭");
            JSONObject forwarded = input;
            long revision = 0;
            if ("center_connect".equals(op)) {
                synchronized (lock) {
                    if (generation == null || generation.process != process || generation.closing || !ownerOpen.getAsBoolean())
                        throw new BridgeException("CANCELLED", "not-sent", "界面会话已关闭");
                    revision = ++centerRevision;
                    centerPending = true;
                    centerBlocked = false;
                    centerReadyObserved = false;
                    pendingCredentials = null;
                    main.removeCallbacks(pendingStatus);
                }
                if ("".equals(input.opt("deviceToken"))) {
                    JSONObject saved;
                    try {
                        synchronized (lock) { saved = credentials.read(); }
                    } catch (Exception failure) {
                        synchronized (lock) { centerPending = false; centerBlocked = true; }
                        throw new BridgeException("CREDENTIALS", "not-sent", "已保存的中心凭据无法读取，请输入新令牌重新连接");
                    }
                    if (saved == null || !saved.getString("url").equals(input.opt("url"))
                            || !saved.getString("deviceId").equals(input.opt("deviceId"))
                            || !saved.getString("ca").equals(input.has("ca") ? input.opt("ca") : "")) {
                        synchronized (lock) { centerPending = false; centerBlocked = true; }
                        throw new BridgeException("CREDENTIALS", "not-sent", "中心地址、设备身份或 CA 不匹配，请输入令牌");
                    }
                    forwarded = new JSONObject(input.toString()).put("deviceToken", saved.getString("deviceToken"));
                }
            } else if ("center_disconnect".equals(op)) {
                if (input.length() != 0) throw new BridgeException("INVALID_ARGUMENT", "not-sent", "断开请求参数无效");
                synchronized (lock) {
                    if (generation == null || generation.process != process || generation.closing || !ownerOpen.getAsBoolean())
                        throw new BridgeException("CANCELLED", "not-sent", "界面会话已关闭");
                    ++centerRevision;
                    centerPending = false;
                    centerBlocked = true;
                    centerReadyObserved = false;
                    restoreNeeded = false;
                    pendingCredentials = null;
                    main.removeCallbacks(pendingStatus);
                    boolean disabled = context.getSharedPreferences("bot_client_connection", Context.MODE_PRIVATE)
                            .edit().putBoolean("enabled", false).commit();
                    if (!disabled) throw new BridgeException("CREDENTIALS", "not-sent", "无法保存断开状态，请重试");
                    try { credentials.clear(); }
                    catch (Exception failure) {
                        throw new BridgeException("CREDENTIALS", "not-sent", "无法清除已保存的中心凭据，请重试");
                    }
                }
            }
            if ("center_connect".equals(op)) synchronized (lock) {
                pendingCredentials = new JSONObject(forwarded.toString());
            }
            final JSONObject sent = forwarded;
            final long attempt = revision;
            final long statusRevision;
            synchronized (lock) { statusRevision = centerRevision; }
            CompletableFuture<JSONObject> reply;
            try {
                reply = process.request("call", new JSONObject().put("method", op).put("params", sent));
            } catch (IOException | JSONException failure) {
                if ("center_connect".equals(op)) synchronized (lock) {
                    centerPending = false;
                    main.postDelayed(pendingStatus, 5000);
                }
                return failed(failure);
            }
            if ("center_connect".equals(op)) {
                return reply.handle((value, failure) -> onControl(() -> {
                    synchronized (lock) {
                        if (attempt != centerRevision || generation == null || generation.process != process
                                || generation.closing) {
                            throw new BridgeException("CANCELLED", "not-sent", "中心连接已被替换或会话已关闭");
                        }
                        centerPending = false;
                        if (failure != null) {
                            String code = BotHostUiProtocol.errorCode(failure);
                            centerBlocked = centerBlocked || isPermanentCenterError(code);
                            if (centerBlocked) pendingCredentials = null;
                            else main.postDelayed(pendingStatus, 5000);
                            return failed(failure);
                        }
                        JSONObject envelope = valueEnvelope(value);
                        if ("ready".equals(envelope.getJSONObject("value").optString("state"))) {
                            persistReady(process);
                        } else {
                            main.postDelayed(pendingStatus, 5000);
                        }
                        return CompletableFuture.completedFuture(centerMetadata(envelope));
                    }
                })).thenCompose(future -> future);
            }
            if ("center_status".equals(op) || "center_disconnect".equals(op)) {
                return reply.thenCompose(value -> onControl(() -> {
                    synchronized (lock) {
                        if (statusRevision != centerRevision || generation == null || generation.process != process
                                || generation.closing) {
                            throw new BridgeException("CANCELLED", "responded", "中心状态已被替换");
                        }
                        JSONObject envelope = valueEnvelope(value);
                        JSONObject status = envelope.getJSONObject("value");
                        JSONObject error = status.optJSONObject("error");
                        boolean permanentError = "center_status".equals(op) && error != null
                                && isPermanentCenterError(error.optString("code"));
                        if (permanentError) {
                            centerBlocked = true;
                            pendingCredentials = null;
                            restoreNeeded = false;
                            main.removeCallbacks(pendingStatus);
                        }
                        if ("center_status".equals(op) && !centerBlocked && pendingCredentials != null
                                && "ready".equals(status.optString("state"))) persistReady(process);
                        if ((centerPending || centerBlocked) && !permanentError) status.put("state", "disconnected");
                        if ("center_status".equals(op)) {
                            boolean ready = !centerBlocked && !centerPending && "ready".equals(status.optString("state"));
                            if (ready && !centerReadyObserved) BotClientService.centerReady();
                            centerReadyObserved = ready;
                        }
                        return CompletableFuture.completedFuture(centerMetadata(envelope));
                    }
                }));
            }
            return reply.thenApply(BotHostClient::valueEnvelope);
        });
    }

    private static boolean isPermanentCenterError(String code) {
        return "INVALID_ARGUMENT".equals(code) || "CREDENTIALS".equals(code)
                || "UNAUTHORIZED".equals(code) || "FORBIDDEN".equals(code)
                || "REVOKED".equals(code) || "CERTIFICATE_ERROR".equals(code);
    }

    /** 调用方持 lock；只有 broker 确认 ready 才保存本次凭据。 */
    private void persistReady(BotHostProcess process) throws BridgeException {
        try {
            credentials.save(pendingCredentials);
            if (!context.getSharedPreferences("bot_client_connection", Context.MODE_PRIVATE)
                    .edit().putBoolean("enabled", true).commit()) throw new IOException("无法保存连接状态");
            new File(new File(context.getFilesDir(), DATA_ROOT), "center-credentials.json").delete();
        } catch (Exception failure) {
            centerBlocked = true;
            pendingCredentials = null;
            try { process.request("call", new JSONObject().put("method", "center_disconnect")
                    .put("params", new JSONObject())); } catch (Exception ignored) { }
            throw new BridgeException("CREDENTIALS", "responded", "连接成功但无法加密保存中心凭据，请重试");
        }
        pendingCredentials = null;
        centerBlocked = false;
        centerReadyObserved = true;
        restoreNeeded = false;
        main.removeCallbacks(pendingStatus);
        BotClientService.requestPoll();
        BotClientService.centerReady();
    }

    private JSONObject centerMetadata(JSONObject envelope) throws JSONException {
        JSONObject status = envelope.getJSONObject("value");
        try {
            JSONObject saved = credentials.read();
            if (saved != null) status.put("savedConnection", CenterClientCredentials.metadata(saved));
        } catch (Exception failure) {
            status.put("savedConnectionError", "已保存的中心凭据无法读取，请输入新令牌重新连接");
        }
        return envelope;
    }

    /**
     * 客户端观察：observationId 由 UI 会话提供（broker 要求 UUID），据此回传
     * DesktopObservationEvent；observationOpen 复核该记录仍属本会话且未关闭，
     * 排队前、派发后各查一次，迟到建立立即按同一 id 撤销。失败只报错，不自动重试。
     */
    CompletableFuture<JSONObject> observe(String ownerId, BooleanSupplier ownerOpen, BooleanSupplier observationOpen,
                                          String observationId, JSONObject target, Consumer<JSONObject> onFrame,
                                          Consumer<Throwable> onError) {
        return onControl(() -> {
            // 排队期间已被 pause/unobserve：不启动进程、不建立观察。
            if (!observationOpen.getAsBoolean()) {
                throw new BridgeException("CANCELLED", "not-sent", "观察已取消");
            }
            BotHostProcess process = acquire(ownerId, ownerOpen);
            ClientObservation record = new ClientObservation(ownerId, process);
            synchronized (lock) {
                if (clientObservations.containsKey(observationId))
                    throw new BridgeException("BUSY", "not-sent", "观察身份已被占用");
                clientObservations.put(observationId, record);
            }
            String id;
            try {
                id = process.observe(observationId, target, frame -> {
                    JSONObject body = frame.optJSONObject("frame");
                    if (frame.has("error") || (body != null && "end".equals(body.optString("type")))) {
                        synchronized (lock) { clientObservations.remove(observationId, record); }
                    }
                    onFrame.accept(frame);
                }, error -> {
                    synchronized (lock) { clientObservations.remove(observationId, record); }
                    onError.accept(error);
                });
            } catch (IOException | RuntimeException failure) {
                synchronized (lock) { clientObservations.remove(observationId, record); }
                return failed(failure);
            }
            if (!observationOpen.getAsBoolean()) {
                synchronized (lock) { clientObservations.remove(observationId, record); }
                process.cancel(id);
                throw new BridgeException("CANCELLED", "not-sent", "观察已取消");
            }
            return CompletableFuture.completedFuture(BotHostUiProtocol.object("observationId", id));
        });
    }

    /** 只撤销本会话自己的客户端观察（broker unobserve），从不影响目标 Host 或 Agent。 */
    void cancel(String ownerId, String observationId) {
        ClientObservation record;
        synchronized (lock) {
            record = clientObservations.get(observationId);
            if (record == null || !record.owner.equals(ownerId)) return;
            clientObservations.remove(observationId);
        }
        record.process.cancel(observationId);
    }

    /** 只恢复中心连接，不重发业务请求。 */
    void restore() {
        JSONObject saved;
        long revision;
        synchronized (lock) {
            if (!BotClientService.isActive() || centerBlocked || restoreQueued || centerPending
                    || (generation != null && !restoreNeeded)) return;
            try {
                if (pendingCredentials != null) saved = new JSONObject(pendingCredentials.toString());
                else {
                    if (!context.getSharedPreferences("bot_client_connection", Context.MODE_PRIVATE)
                            .getBoolean("enabled", true)) return;
                    saved = credentials.read();
                    if (saved == null) return;
                    saved.put("deviceToken", "");
                }
                restoreNeeded = false;
                restoreQueued = true;
                revision = centerRevision;
            } catch (Exception ignored) { return; }
        }
        request("background", BotClientService.ownerOpen(), "center_connect", saved, revision).whenComplete((v, e) -> {
            synchronized (lock) { restoreQueued = false; }
        });
    }

    void checkConnection() {
        checkConnection(false);
    }

    void checkConnection(boolean probe) {
        if (!BotClientService.isActive()) return;
        synchronized (lock) {
            if (generation == null || restoreNeeded) { restore(); return; }
            if (!generation.current || generation.closing || centerPending || centerBlocked) return;
        }
        checkStatus(probe);
    }

    private CompletableFuture<JSONObject> checkStatus() {
        return checkStatus(false);
    }

    private CompletableFuture<JSONObject> checkStatus(boolean probe) {
        long revision;
        synchronized (lock) { revision = centerRevision; }
        JSONObject params = probe ? BotHostUiProtocol.object("probe", true) : new JSONObject();
        return request("background", BotClientService.ownerOpen(), "center_status", params, revision);
    }

    // ---------- 单写者与懒启动 ----------

    private BotHostProcess acquire(String ownerId, BooleanSupplier ownerOpen) throws BridgeException {
        if (!ownerOpen.getAsBoolean()) throw new BridgeException("CANCELLED", "not-sent", "界面会话已关闭");
        synchronized (lock) {
            if (generation != null) {
                if (generation.current && !generation.closing) {
                    return generation.process;
                }
                throw new BridgeException("BUSY", "not-sent", "客户端由其他界面会话占用或上一代未回收");
            }
            // 启动占位：从此刻起同目录的下一代一律 BUSY。
            generation = new Generation(ownerId);
        }
        JSONObject init;
        try {
            init = clientInit();
        } catch (IOException failure) {
            clearReservation(ownerId);
            throw new BridgeException("LAUNCH_FAILED", "not-sent", "客户端目录不可用");
        }
        synchronized (lock) {
            if (generation == null || generation.closing || !ownerOpen.getAsBoolean()) {
                clearReservation(ownerId);
                throw new BridgeException("CANCELLED", "not-sent", "客户端已关闭");
            }
        }
        BotHostProcess launched = null;
        BridgeException launchError = null;
        try {
            // 首次请求或前台服务恢复时创建 child。
            launched = BotHostProcess.launch(context, init, listener).join();
        } catch (Throwable failure) {
            launchError = launchFailure(failure);
        }
        boolean discard;
        boolean sessionClosed;
        synchronized (lock) {
            Generation reserved = generation;
            if (launched == null && reserved != null) launched = reserved.process;
            sessionClosed = !ownerOpen.getAsBoolean();
            discard = launchError != null || reserved == null || launched == null
                    || reserved.closing || sessionClosed;
            if (reserved != null && discard) {
                reserved.closing = true;
                reserved.current = false;
                // 尚未创建任何进程（init 被拒）时没有需要保留的占有，否则等 onExit。
                if (reserved.process == null && generation == reserved) {
                    generation = null;
                    reserved.closeDone.complete(null);
                }
            } else if (reserved != null) {
                reserved.current = true;
            }
        }
        if (discard) {
            closeQuietly(launched);
            if (launchError != null) throw launchError;
            if (sessionClosed) throw new BridgeException("CANCELLED", "not-sent", "界面会话已关闭");
            throw new BridgeException("CLOSED", "not-sent", "客户端进程已结束");
        }
        return launched;
    }

    /** 未创建进程即失败的启动只撤销占位，不会留下需要回收的占有。 */
    private void clearReservation(String ownerId) {
        synchronized (lock) {
            if (generation != null && generation.process == null && generation.owner.equals(ownerId)) {
                Generation reserved = generation;
                generation = null;
                reserved.closeDone.complete(null);
            }
        }
    }

    /** 停止中心恢复并撤销当前代准入；凭据和已受理任务保持不变。 */
    CompletableFuture<Void> shutdown() {
        Generation closing;
        BotHostProcess process;
        synchronized (lock) {
            ++centerRevision;
            centerPending = false;
            centerReadyObserved = false;
            pendingCredentials = null;
            restoreNeeded = true;
            main.removeCallbacks(pendingStatus);
            closing = generation;
            if (closing == null) return CompletableFuture.completedFuture(null);
            closing.closing = true;
            closing.current = false;
            process = closing.process;
        }
        if (process != null) closeGeneration(closing, process);
        return closing.closeDone;
    }

    private void closeGeneration(Generation closing, BotHostProcess process) {
        process.close().whenComplete((ignored, error) -> {
            if (error != null && process.isAlive()) closing.closeDone.completeExceptionally(error);
        });
    }

    private JSONObject clientInit() throws IOException {
        File root = new File(context.getFilesDir(), DATA_ROOT);
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法创建 bot-client 目录");
        try {
            return new JSONObject()
                    .put("type", "init")
                    .put("protocol", 1)
                    .put("mode", "client")
                    .put("dataRoot", root.getAbsolutePath());
        } catch (JSONException failure) {
            throw new IOException("客户端 init 帧构造失败");
        }
    }

    private final BotHostProcess.Listener listener = new BotHostProcess.Listener() {
        /** 进程一创建就登记占有：启动失败或被放弃也走同一受跟踪的关闭路径。 */
        @Override public void onStarting(BotHostProcess process) {
            Generation closing = null;
            synchronized (lock) {
                if (generation != null && generation.process == null) {
                    generation.process = process;
                    if (generation.closing) closing = generation;
                }
            }
            if (closing != null) closeGeneration(closing, process);
        }

        @Override public void onReady(BotHostProcess process, JSONObject ready) {
            // ready 由 launch future 交付；client 模式没有额外绑定。
        }

        @Override public void onNativeFrame(BotHostProcess process, JSONObject frame) {
            // client 模式不派发 native 工具调用：意外帧一律忽略。
        }

        /** 唯一解除占有的地方：BotHostProcess 保证真实退出（或回收结果未知时推迟）后通知一次。 */
        @Override public void onExit(BotHostProcess process, int exitCode, boolean graceful) {
            Generation exited = null;
            synchronized (lock) {
                if (generation != null && generation.process == process) {
                    exited = generation;
                    generation = null;
                    clientObservations.entrySet().removeIf(entry -> entry.getValue().process == process);
                    centerPending = false;
                    centerReadyObserved = false;
                    ++centerRevision;
                    if (!centerBlocked) {
                        restoreNeeded = true;
                        if (pendingCredentials != null && BotClientService.isActive()) main.post(pendingStatus);
                    }
                }
            }
            if (exited != null) exited.closeDone.complete(null);
        }
    };

    // ---------- 串行控制执行器 ----------

    private CompletableFuture<JSONObject> onControl(ControlTask task) {
        CompletableFuture<JSONObject> promise = new CompletableFuture<>();
        try {
            control.execute(() -> {
                CompletableFuture<JSONObject> inner;
                try {
                    inner = task.call();
                } catch (Throwable failure) {
                    promise.completeExceptionally(failure);
                    return;
                }
                inner.whenComplete((value, failure) -> {
                    if (failure != null) promise.completeExceptionally(failure);
                    else promise.complete(value);
                });
            });
        } catch (RejectedExecutionException busy) {
            promise.completeExceptionally(new BridgeException("BUSY", "not-sent", "客户端请求排队已满"));
        }
        return promise;
    }

    private interface ControlTask {
        CompletableFuture<JSONObject> call() throws Exception;
    }

    // ---------- 工具 ----------

    /** Node 固定返回 {value:&lt;broker 结果&gt;}；缺失/null 之外的结构一律按协议错误拒绝。 */
    private static JSONObject valueEnvelope(JSONObject envelope) {
        Object result = envelope == null ? null : envelope.opt("result");
        if (envelope != null && "result".equals(envelope.optString("type"))
                && result instanceof JSONObject value && value.has("value")) {
            return value;
        }
        throw new CompletionException(new BridgeException("PROTOCOL", "invalid", "客户端响应无效"));
    }

    private static BridgeException launchFailure(Throwable failure) {
        Throwable cause = failure;
        while ((cause instanceof CompletionException || cause instanceof ExecutionException)
                && cause.getCause() != null && cause.getCause() != cause) {
            cause = cause.getCause();
        }
        if (cause instanceof BridgeException) return (BridgeException) cause;
        if (cause instanceof IOException) return new BridgeException("LAUNCH_FAILED", "not-sent", "客户端启动失败");
        return new BridgeException("INTERNAL", "not-sent", "客户端启动失败");
    }

    private static CompletableFuture<JSONObject> failed(Throwable failure) {
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        future.completeExceptionally(failure);
        return future;
    }

    /** 只发起关闭（幂等、异步 cleanup）；确认退出由 onExit 通知，调用方不阻塞。 */
    private static void closeQuietly(BotHostProcess process) {
        if (process == null) return;
        try {
            process.close();
        } catch (Throwable ignored) {
        }
    }
}
