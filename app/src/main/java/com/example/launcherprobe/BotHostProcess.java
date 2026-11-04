package com.example.launcherprobe;

import android.content.Context;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/**
 * 重启式私有子进程传输：真实 stdin/stdout JSONL，无 TCP/抽象 socket。
 * 创建 child 的 Java 线程必须一直 waitFor 到 child 退出，满足 PR_SET_PDEATHSIG
 * 按线程归属的约束；一个 child 代对应一个实例，回调运行在 reader 线程。
 */
final class BotHostProcess {

    interface Listener {
        /** 同步于 launch 调用 start() 之前；为 Manager 提供尚未 ready 的对象。 */
        default void onStarting(BotHostProcess process) {
        }

        void onReady(BotHostProcess process, JSONObject ready);

        void onNativeFrame(BotHostProcess process, JSONObject frame);

        void onExit(BotHostProcess process, int exitCode, boolean graceful);
    }

    /** 携带固定 code/outcome 的传输级异常，绝不回显密钥/模型内容。 */
    static final class BridgeException extends IOException {
        public final String code;
        public final String outcome;

        BridgeException(String code, String outcome, String message) {
            super(message);
            this.code = code;
            this.outcome = outcome;
        }
    }

    private static final int PROTOCOL = 1;
    private static final int MAX_RAW_FRAME = 40 * 1024 * 1024;
    private static final int MAX_CONTROL_FRAME = 40 * 1024 * 1024;
    private static final int MAX_REQUESTS = 8;
    private static final int MAX_OBSERVERS = 8;
    private static final long WRITE_TIMEOUT_MS = 5_000;
    private static final long STARTUP_TIMEOUT_MS = 30_000;
    private static final long REQUEST_TIMEOUT_MS = 30_000;
    /** 记忆方法外层等待：后端 reflect 最长 120s，留出协议/传输余量。 */
    private static final long MEMORY_REQUEST_TIMEOUT_MS = 150_000;
    private static final long CLOSE_TIMEOUT_MS = 30_000;
    private static final long EXIT_AWAIT_MS = 5_000;
    private static final int QUEUE_CAPACITY = 4;
    private static final long QUEUE_BYTE_BUDGET = 80L * 1024 * 1024;
    private static final List<String> REQUEST_TYPES =
            Arrays.asList("call", "status", "settings_get", "settings_set");
    /** 长运行方法（八个 Hindsight 记忆 + 手动压缩）；其余方法沿用 REQUEST_TIMEOUT_MS。 */
    private static final List<String> MEMORY_METHODS =
            Arrays.asList("memoryStatus", "recallMemory", "reflectMemory", "retainMemory",
                    "getMemory", "getMemorySource", "correctMemory", "retryMemory", "compact");

    private final Context context;
    private final JSONObject init;
    private final Listener listener;
    private final String initMode;
    private final CompletableFuture<BotHostProcess> launchFuture = new CompletableFuture<>();
    private final CompletableFuture<Void> closeFuture = new CompletableFuture<>();
    private final Object lock = new Object();
    private final Map<String, Pending> pending = new HashMap<>();
    private final AtomicLong queuedBytes = new AtomicLong();
    private final AtomicBoolean exitNotified = new AtomicBoolean();
    private final CountDownLatch spawnLatch = new CountDownLatch(1);
    private final CountDownLatch exitLatch = new CountDownLatch(1);
    private final List<Thread> transportThreads = new ArrayList<>();

    private BotHostAssets assets;
    private Process process;
    private BlockingQueue<Frame> outQueue;
    private ScheduledExecutorService scheduler;
    private volatile JSONObject ready;
    private volatile boolean finished;
    private volatile boolean closeRequested;
    private volatile boolean forcedDestroy;
    private volatile boolean waitForDone;
    private volatile boolean spawnOutcome;
    private volatile String shutdownId;
    private volatile long closeDeadlineNanos;
    private volatile int childExitCode = -1;
    private volatile Throwable childSpawnFailure;
    private volatile boolean shutdownMatched;
    private Thread cleanupThread;
    private int activeRequests;
    private int activeObservers;

    private BotHostProcess(Context context, JSONObject init, Listener listener) throws BridgeException {
        this.context = context.getApplicationContext();
        this.init = init;
        this.listener = listener;
        if (init == null) throw new BridgeException("LAUNCH_FAILED", "not-sent", "缺少 init 帧");
        if (!"init".equals(init.optString("type")) || init.optInt("protocol", -1) != PROTOCOL) {
            throw new BridgeException("LAUNCH_FAILED", "not-sent", "init 帧无效");
        }
        String mode = init.optString("mode");
        if (!"host".equals(mode) && !"settings".equals(mode) && !"client".equals(mode)) {
            throw new BridgeException("LAUNCH_FAILED", "not-sent", "init 帧无效");
        }
        initMode = mode;
    }

    private void debugLog(String stage) {
        if ((context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            Log.d("BotHostProcess", "mode=" + initMode + " " + stage);
        }
    }

    static CompletableFuture<BotHostProcess> launch(Context context, JSONObject init, Listener listener) {
        BotHostProcess host;
        try {
            host = new BotHostProcess(context, init, listener);
        } catch (BridgeException e) {
            CompletableFuture<BotHostProcess> failed = new CompletableFuture<>();
            failed.completeExceptionally(e);
            return failed;
        }
        if (listener != null) listener.onStarting(host);
        host.start();
        return host.launchFuture;
    }

    private void start() {
        scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "bot-host-timer");
            thread.setDaemon(true);
            return thread;
        });
        scheduler.schedule(this::startupTimeout, STARTUP_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        // launchFuture 被取消（如 Manager 取消启动）必须联动闭环，不能遗留 child。
        launchFuture.whenComplete((host, err) -> {
            if (err instanceof CancellationException) {
                terminate(new BridgeException("CANCELLED", "cancelled", "启动已取消"));
            }
        });
        Thread child = new Thread(this::childMain, "bot-host-child");
        child.setDaemon(true);
        child.start();
    }

    /** 创建 child 的线程：builder.start 后一直 waitFor 到 child 退出。 */
    private void childMain() {
        boolean deniedSpawn = false;
        try {
            byte[] initBytes = init.toString().getBytes(StandardCharsets.UTF_8);
            if (initBytes.length > MAX_CONTROL_FRAME) throw new IOException("init 帧超限");
            assets = BotHostAssets.prepare(context);
            File launcher = new File(context.getApplicationInfo().nativeLibraryDir, "libnode_launcher.so");
            if (!launcher.isFile()) throw new IOException("内置 Node 启动器缺失");
            // builder.start 前再次确认：已收尾或已请求关闭则不创建 child。
            synchronized (lock) {
                if (finished || closeRequested) deniedSpawn = true;
            }
            if (!deniedSpawn) {
                ProcessBuilder builder = new ProcessBuilder(
                        launcher.getAbsolutePath(),
                        "--host-parent-pid",
                        String.valueOf(android.os.Process.myPid()),
                        assets.entry.getAbsolutePath());
                configureEnvironment(builder);
                builder.directory(assets.workspace);
                Process spawned = builder.start();
                boolean skipStart;
                synchronized (lock) {
                    process = spawned;
                    // finish/close 若在 builder.start 期间发生，晚到 child 立即回收。
                    skipStart = finished;
                }
                if (!skipStart) {
                    debugLog("spawned");
                    onSpawned(spawned, initBytes);
                } else {
                    forcedDestroy = true;
                    try {
                        spawned.destroy();
                    } catch (Throwable ignored) {
                    }
                }
            }
        } catch (Throwable t) {
            childSpawnFailure = t;
        } finally {
            // spawn 结局（早于进程退出）先发布，供收尾线程解除等待。
            spawnOutcome = true;
            spawnLatch.countDown();
        }
        if (childSpawnFailure != null) {
            // 异步收尾；本线程仍继续执行下方 waitFor，绝不自我等待 exitLatch。
            forcedDestroy = true;
            requestCleanup(false, toBridge(childSpawnFailure));
        }
        if (deniedSpawn || process == null) {
            exitLatch.countDown();
            return;
        }
        int code;
        try {
            code = process.waitFor();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            code = -1;
        }
        childExitCode = code;
        waitForDone = true;
        exitLatch.countDown();
    }

    private void onSpawned(Process spawned, byte[] initBytes) throws IOException {
        outQueue = new ArrayBlockingQueue<>(QUEUE_CAPACITY);
        Thread writerThread = new Thread(this::writeLoop, "bot-host-writer");
        Thread readerThread = new Thread(this::readLoop, "bot-host-reader");
        Thread stderrThread = new Thread(this::drainStderr, "bot-host-stderr");
        writerThread.setDaemon(true);
        readerThread.setDaemon(true);
        stderrThread.setDaemon(true);
        transportThreads.add(writerThread);
        transportThreads.add(readerThread);
        transportThreads.add(stderrThread);
        writerThread.start();
        readerThread.start();
        stderrThread.start();
        enqueue(new Frame(initBytes, null));
        debugLog("init written");
    }

    private void configureEnvironment(ProcessBuilder builder) {
        Map<String, String> env = builder.environment();
        env.clear();
        for (Map.Entry<String, String> inherited : System.getenv().entrySet()) {
            String key = inherited.getKey();
            if (key.startsWith("ANDROID_") || "BOOTCLASSPATH".equals(key)
                    || "DEX2OATBOOTCLASSPATH".equals(key) || "SYSTEMSERVERCLASSPATH".equals(key)
                    || "LANG".equals(key) || key.startsWith("LC_")) {
                env.put(key, inherited.getValue());
            }
        }
        env.put("HOME", assets.home.getAbsolutePath());
        env.put("TMPDIR", new File(assets.home, "tmp").getAbsolutePath());
        env.put("LD_LIBRARY_PATH", context.getApplicationInfo().nativeLibraryDir);
        env.put("PI_AGENT_DIR", new File(assets.home, ".pi/agent").getAbsolutePath());
        env.put("PATH", assets.bin.getAbsolutePath() + ":" + "/system/bin:/system/xbin:/vendor/bin");
    }

    private void drainStderr() {
        try {
            InputStream err = process.getErrorStream();
            byte[] buffer = new byte[4096];
            while (err.read(buffer) >= 0) {
                // 只排空，不回显原始内容/凭据。
            }
        } catch (IOException ignored) {
        }
    }

    private void startupTimeout() {
        if (!launchFuture.isDone() && !closeRequested) {
            terminate(new BridgeException("STARTUP_TIMEOUT", "unconfirmed", "Host 启动超时"));
        }
    }

    private void terminate(BridgeException failure) {
        forcedDestroy = true;
        requestCleanup(false, failure);
    }

    /** 幂等收尾入口：单一 cleanup 线程执行 finish，避免 reader/创建线程同步阻塞。 */
    private void requestCleanup(boolean graceful, BridgeException failure) {
        Thread thread;
        synchronized (lock) {
            if (finished || cleanupThread != null) return;
            cleanupThread = new Thread(() -> finish(graceful, failure), "bot-host-cleanup");
            thread = cleanupThread;
        }
        thread.setDaemon(true);
        thread.start();
    }

    private static final class Frame {
        final byte[] bytes;
        final Pending pending;
        final String pendingId;
        private final CountDownLatch done = new CountDownLatch(1);
        volatile boolean possiblySent;
        volatile boolean written;

        Frame(byte[] bytes, Pending pending) {
            this.bytes = bytes;
            this.pending = pending;
            this.pendingId = pending == null ? null : pending.id;
        }

        void release() {
            done.countDown();
        }

        boolean await(long timeoutMs) throws InterruptedException {
            return done.await(timeoutMs, TimeUnit.MILLISECONDS);
        }
    }

    private void writeLoop() {
        try {
            OutputStream out = process.getOutputStream();
            while (true) {
                Frame frame = outQueue.poll(200, TimeUnit.MILLISECONDS);
                if (frame == null) {
                    if (finished) break;
                    continue;
                }
                boolean dispatch;
                synchronized (lock) {
                    if (finished) {
                        dispatch = false;
                    } else if (frame.pending != null) {
                        // closeRequested 后排队中的用户请求取消写出；内部 shutdown/cancel 帧不受限。
                        if (closeRequested || pending.get(frame.pendingId) != frame.pending) {
                            dispatch = false;
                        } else {
                            // 原子决定发放并标记可能已发送，避免取消竞态漏发 cancel。
                            dispatch = true;
                            frame.pending.sent = true;
                            frame.possiblySent = true;
                        }
                    } else {
                        // 内部帧（init/shutdown/cancel）同样在第一字节前标记可能已发送。
                        dispatch = true;
                        frame.possiblySent = true;
                    }
                }
                if (dispatch) {
                    // 写入紧随上述锁内判定；失败只能算 unconfirmed。
                    try {
                        out.write(frame.bytes);
                        out.write('\n');
                        out.flush();
                        frame.written = true;
                    } catch (IOException e) {
                        if (!finished) terminate(new BridgeException("CLOSED", "unconfirmed", "传输写入失败"));
                    }
                }
                frame.release();
                queuedBytes.addAndGet(-frame.bytes.length);
                if (finished && outQueue.isEmpty()) break;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        List<Frame> leftover = new ArrayList<>();
        outQueue.drainTo(leftover);
        for (Frame frame : leftover) {
            frame.release();
            queuedBytes.addAndGet(-frame.bytes.length);
        }
    }

    private void enqueue(Frame frame) throws IOException {
        // 仅 finished 拒绝写入；closeRequested 只拦用户请求（request/observe/sendNativeResult），
        // 内部 shutdown/cancel 帧仍必须允许按序发送一次。
        if (finished) throw new BridgeException("CLOSED", "not-sent", "Host 已关闭");
        long size = frame.bytes.length;
        while (true) {
            long current = queuedBytes.get();
            if (current + size > QUEUE_BYTE_BUDGET) {
                throw new BridgeException("BUSY", "not-sent", "传输队列繁忙");
            }
            if (queuedBytes.compareAndSet(current, current + size)) break;
        }
        boolean queued;
        try {
            queued = outQueue.offer(frame, WRITE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            queuedBytes.addAndGet(-size);
            throw new BridgeException("BUSY", "not-sent", "发送被中断");
        }
        if (!queued) {
            queuedBytes.addAndGet(-size);
            throw new BridgeException("BUSY", "not-sent", "传输队列繁忙");
        }
        boolean done;
        try {
            done = frame.await(WRITE_TIMEOUT_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            done = false;
        }
        if (!done) {
            boolean stillOwned = false;
            if (frame.pending != null) synchronized (lock) {
                stillOwned = pending.get(frame.pendingId) == frame.pending;
            }
            if (!stillOwned) return; // 已取消/已移除，无需回报
            if (!finished) terminate(new BridgeException("CLOSED", "unconfirmed", "传输写入超时"));
            throw new BridgeException("CLOSED", frame.possiblySent ? "unconfirmed" : "not-sent", "Host 已关闭");
        }
    }

    /**
     * 是否为记忆方法调用：本机 Host 的 call 直接带控制方法名，client 模式 broker 的
     * call 把真实方法嵌在 params.method；只按确切名字判断，不整体放宽期限。
     */
    static boolean isMemoryCall(JSONObject fields) {
        if (fields == null) return false;
        String method = fields.optString("method", "");
        if (MEMORY_METHODS.contains(method)) return true;
        if (!"call".equals(method)) return false;
        JSONObject inner = fields.optJSONObject("params");
        return inner != null && MEMORY_METHODS.contains(inner.optString("method", ""));
    }

    CompletableFuture<JSONObject> request(String type, JSONObject fields) throws IOException {
        if (ready == null) throw new IllegalStateException("Host 未就绪");
        if (!REQUEST_TYPES.contains(type)) throw new IllegalArgumentException("不支持的请求类型：" + type);
        if (fields != null && (fields.has("type") || fields.has("id"))) {
            throw new IllegalArgumentException("不允许覆盖 type/id");
        }
        String id = UUID.randomUUID().toString();
        JSONObject command;
        try {
            command = new JSONObject().put("type", type).put("id", id);
            if (fields != null) {
                Iterator<String> keys = fields.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    command.put(key, fields.get(key));
                }
            }
        } catch (JSONException e) {
            throw new BridgeException("INVALID_FRAME", "not-sent", "请求帧构造失败");
        }
        byte[] bytes = command.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_CONTROL_FRAME) {
            throw new BridgeException("TOO_LARGE", "not-sent", "请求帧超限");
        }
        long timeoutMs = isMemoryCall(fields) ? MEMORY_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        Pending entry = new Pending(id, false, future, null);
        synchronized (lock) {
            if (finished || closeRequested) throw new BridgeException("CLOSED", "not-sent", "Host 已关闭");
            if (activeRequests >= MAX_REQUESTS) throw new BridgeException("BUSY", "not-sent", "请求并发已满");
            activeRequests++;
            pending.put(id, entry);
        }
        try {
            entry.timer = scheduler.schedule(() -> expireRequest(id, entry), timeoutMs, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            // 已进入收尾，出 finish 统一完成。
        }
        future.whenComplete((res, err) -> {
            if (err instanceof CancellationException) {
                boolean removed = false;
                synchronized (lock) {
                    if (pending.get(id) == entry) {
                        pending.remove(id);
                        activeRequests--;
                        if (entry.timer != null) entry.timer.cancel(false);
                        removed = true;
                    }
                }
                if (removed && entry.sent) sendCancel(id);
            }
        });
        try {
            enqueue(new Frame(bytes, entry));
        } catch (IOException e) {
            synchronized (lock) {
                if (pending.remove(id) == entry) {
                    activeRequests--;
                    if (entry.timer != null) entry.timer.cancel(false);
                }
            }
            throw e;
        }
        return future;
    }

    private void expireRequest(String id, Pending entry) {
        boolean removed;
        synchronized (lock) {
            removed = pending.get(id) == entry;
            if (removed) {
                pending.remove(id);
                activeRequests--;
            }
        }
        if (removed) {
            if (entry.sent) sendCancel(id);
            entry.future.completeExceptionally(new BridgeException(
                    "TIMEOUT", entry.sent ? "unconfirmed" : "not-sent", "请求超时"));
        }
    }

    String observe(JSONObject target, Consumer<JSONObject> onFrame, Consumer<Throwable> onError) throws IOException {
        return observe(UUID.randomUUID().toString(), target, onFrame, onError);
    }

    /**
     * 显式观察 id：client 模式用 UI 会话给的 observationId 作为帧 id，使 broker 事件与
     * 前端 id 一一对应。调用方保证同一连接内不复用；冲突按受控错误拒绝。
     */
    String observe(String observationId, JSONObject target, Consumer<JSONObject> onFrame,
                   Consumer<Throwable> onError) throws IOException {
        if (ready == null) throw new IllegalStateException("Host 未就绪");
        if (onFrame == null || onError == null) throw new NullPointerException("观察回调缺失");
        if (target == null) throw new BridgeException("INVALID_FRAME", "not-sent", "观察目标无效");
        if (observationId == null || observationId.isEmpty() || observationId.length() > 128) {
            throw new BridgeException("INVALID_FRAME", "not-sent", "观察 id 无效");
        }
        JSONObject frameTarget = target;
        JSONObject live = target;
        if ("client".equals(initMode)) {
            // client 模式只放行固定形状 {targetDeviceId, target}，不转发任意字段。
            Object targetDeviceId = target.opt("targetDeviceId");
            JSONObject inner = target.optJSONObject("target");
            if (!(targetDeviceId instanceof String) || ((String) targetDeviceId).isEmpty()
                    || ((String) targetDeviceId).length() > 256) {
                throw new BridgeException("INVALID_FRAME", "not-sent", "观察目标 deviceId 无效");
            }
            if (inner == null) throw new BridgeException("INVALID_FRAME", "not-sent", "观察目标无效");
            try {
                frameTarget = new JSONObject().put("targetDeviceId", targetDeviceId).put("target", inner);
            } catch (JSONException e) {
                throw new BridgeException("INVALID_FRAME", "not-sent", "观察帧构造失败");
            }
            live = inner;
        }
        String kind = live.optString("kind");
        boolean connection = "client".equals(initMode) && "connection".equals(kind);
        if (!connection && !"primary".equals(kind) && !"work".equals(kind)) {
            throw new BridgeException("INVALID_FRAME", "not-sent", "观察目标类型无效");
        }
        if (!connection && live.optString("botId").isEmpty()) {
            throw new BridgeException("INVALID_FRAME", "not-sent", "观察目标缺 botId");
        }
        if ("work".equals(kind) && live.optString("scopeId").isEmpty()) {
            throw new BridgeException("INVALID_FRAME", "not-sent", "观察目标缺 scopeId");
        }
        String id = observationId;
        JSONObject command;
        try {
            command = new JSONObject().put("type", "observe").put("id", id).put("target", frameTarget);
        } catch (JSONException e) {
            throw new BridgeException("INVALID_FRAME", "not-sent", "观察帧构造失败");
        }
        byte[] bytes = command.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_CONTROL_FRAME) {
            throw new BridgeException("TOO_LARGE", "not-sent", "观察帧超限");
        }
        Pending entry = new Pending(id, true, null, new Observer(onFrame, onError));
        entry.connection = connection;
        synchronized (lock) {
            if (finished || closeRequested) throw new BridgeException("CLOSED", "not-sent", "Host 已关闭");
            int business = 0;
            boolean watch = false;
            for (Pending item : pending.values()) {
                if (item.observer) {
                    if (item.connection) watch = true;
                    else business++;
                }
            }
            if (connection ? watch : business >= MAX_OBSERVERS)
                throw new BridgeException("BUSY", "not-sent", "观察并发已满");
            if (pending.containsKey(id)) throw new BridgeException("INVALID_FRAME", "not-sent", "观察 id 冲突");
            activeObservers++;
            pending.put(id, entry);
        }
        try {
            enqueue(new Frame(bytes, entry));
        } catch (IOException e) {
            synchronized (lock) {
                if (pending.remove(id) == entry) activeObservers--;
            }
            throw e;
        }
        return id;
    }

    void cancel(String id) {
        Pending entry;
        synchronized (lock) {
            entry = pending.get(id);
            if (entry == null) return;
            pending.remove(id);
            if (entry.observer) activeObservers--;
            else activeRequests--;
            if (entry.timer != null) entry.timer.cancel(false);
        }
        if (entry.sent) sendCancel(id);
        if (!entry.observer && !entry.future.isDone()) {
            entry.future.completeExceptionally(new BridgeException("CANCELLED", "cancelled", "请求已取消"));
        }
    }

    private void sendCancel(String id) {
        try {
            JSONObject frame = new JSONObject().put("type", "cancel").put("id", id);
            enqueue(new Frame(frame.toString().getBytes(StandardCharsets.UTF_8), null));
        } catch (IOException | JSONException ignored) {
            // 传输失败由统一关闭路径处理。
        }
    }

    void sendNativeResult(JSONObject frame) throws IOException {
        if (ready == null) throw new IllegalStateException("Host 未就绪");
        if (frame == null || !"native_result".equals(frame.optString("type"))) {
            throw new BridgeException("INVALID_FRAME", "not-sent", "native_result 帧无效");
        }
        if (frame.optString("id").isEmpty()) {
            throw new BridgeException("INVALID_FRAME", "not-sent", "native_result 缺 id");
        }
        boolean hasResult = frame.has("result");
        boolean hasError = frame.has("error");
        if (hasResult == hasError) {
            throw new BridgeException("INVALID_FRAME", "not-sent", "native_result 必须且只能有 result/error");
        }
        byte[] bytes = frame.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_RAW_FRAME) {
            throw new BridgeException("TOO_LARGE", "not-sent", "native_result 帧超限");
        }
        enqueue(new Frame(bytes, null));
    }

    JSONObject readyInfo() {
        return ready;
    }

    /** 反映真实子进程存活（即使协议已收尾）；供 Manager 防止清理失败时替换生成。 */
    boolean isAlive() {
        return process != null && process.isAlive();
    }

    private void readLoop() {
        InputStream in = process.getInputStream();
        BoundedLineReader lines = new BoundedLineReader(MAX_RAW_FRAME);
        CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            while (!finished) {
                byte[] line = lines.readLine(in);
                if (line == null) break;
                String text;
                try {
                    CharBuffer decoded = decoder.decode(ByteBuffer.wrap(line));
                    text = decoded.toString();
                    decoder.reset();
                } catch (CharacterCodingException e) {
                    throw new IOException("帧非 UTF-8");
                }
                JSONObject message = parseFrame(text);
                if (message.isNull("type")) throw new IOException("帧缺 type");
                handleMessage(message);
            }
            if (!finished) {
                synchronized (lock) {
                    // 已匹配 closed 后 EOF 只停止读取，exit 判定由收尾线程完成。
                    if (shutdownMatched) return;
                }
                terminate(new BridgeException("CLOSED", "unconfirmed", "子进程连接结束"));
            }
        } catch (IOException e) {
            if (!finished) terminate(new BridgeException("CLOSED", "unconfirmed", "传输读取失败"));
        } catch (Throwable t) {
            if (!finished) terminate(toBridge(t));
        }
    }

    private void handleMessage(JSONObject message) {
        switch (message.optString("type")) {
            case "ready":
                handleReady(message);
                break;
            case "result":
            case "error":
                handleResponse(message);
                break;
            case "frame":
                handleFrame(message);
                break;
            case "closed":
                handleClosed(message);
                break;
            case "native_call":
                if (validNativeCall(message)) {
                    notifyNative(message);
                } else {
                    terminate(new BridgeException("PROTOCOL", "invalid", "native_call 帧无效"));
                }
                break;
            case "native_cancel":
                if (!message.optString("id").isEmpty()) {
                    notifyNative(message);
                } else {
                    terminate(new BridgeException("PROTOCOL", "invalid", "native_cancel 帧无效"));
                }
                break;
            default:
                terminate(new BridgeException("PROTOCOL", "invalid", "未知帧类型"));
        }
    }

    private static final List<String> NATIVE_TOOLS =
            Arrays.asList("android_apps", "android_shower", "android_speak", "schedule_task", "shower_surface");

    private boolean validNativeCall(JSONObject message) {
        if (message.optString("id").isEmpty()) return false;
        String tool = message.optString("tool");
        if (!NATIVE_TOOLS.contains(tool)) return false;
        JSONObject context = message.optJSONObject("context");
        if (context == null) return false;
        if (context.optString("deviceId").isEmpty() || context.optString("botId").isEmpty()
                || context.optString("conversationId").isEmpty()) {
            return false;
        }
        String kind = context.optString("kind");
        if (!"primary".equals(kind) && !"room".equals(kind) && !"dm".equals(kind)) return false;
        if ("primary".equals(kind)) {
            // primary 不允许携带 scopeId。
            if (!context.isNull("scopeId")) return false;
        } else if (context.optString("scopeId").isEmpty()) {
            return false;
        }
        // JS 安全整数上限 9007199254740991，精确校验且不得带小数（不得强转 int）。
        // 唯一例外：shower_surface 的人工调用带 manager 合成的 'human:'+UUID（不是模型参数），
        // 规则与 android-bridge-protocol.js / BotHostNativeTools 完全一致。
        Object taskId = context.opt("taskId");
        if ("shower_surface".equals(tool) && taskId instanceof String) {
            return BotHostNativeTools.isHumanTaskId(taskId);
        }
        if (!(taskId instanceof Number)) return false;
        double value = ((Number) taskId).doubleValue();
        return value > 0 && value <= 9007199254740991L && value == Math.floor(value);
    }

    private void notifyNative(JSONObject message) {
        try {
            listener.onNativeFrame(this, message);
        } catch (Throwable ignored) {
        }
    }

    private void handleReady(JSONObject message) {
        if (ready != null || finished) {
            terminate(new BridgeException("INVALID_READY", "invalid", "重复或过期 ready"));
            return;
        }
        if (message.optInt("protocol", -1) != PROTOCOL || message.optString("deviceId").isEmpty()
                || message.optString("nodeVersion").isEmpty() || message.optString("platform").isEmpty()
                || message.optString("arch").isEmpty()) {
            terminate(new BridgeException("INVALID_READY", "invalid", "ready 字段无效"));
            return;
        }
        if ("settings".equals(initMode) || "client".equals(initMode)) {
            if (!message.isNull("url")) {
                terminate(new BridgeException("INVALID_READY", "invalid", "settings/client 模式 url 须为 null"));
                return;
            }
        } else if (!message.isNull("url") && message.optString("url").isEmpty()) {
            terminate(new BridgeException("INVALID_READY", "invalid", "ready url 字段无效"));
            return;
        }
        ready = message;
        debugLog("ready");
        try {
            listener.onReady(this, message);
        } catch (Throwable t) {
            terminate(toBridge(t));
            return;
        }
        if (!launchFuture.isDone()) launchFuture.complete(this);
    }

    private void handleResponse(JSONObject message) {
        String id = message.optString("id");
        if (id.isEmpty()) {
            terminate(new BridgeException("PROTOCOL", "invalid", "响应缺 id"));
            return;
        }
        Pending entry;
        synchronized (lock) {
            entry = pending.get(id);
            if (entry != null) {
                pending.remove(id);
                if (entry.observer) activeObservers--;
                else activeRequests--;
                if (entry.timer != null) entry.timer.cancel(false);
            }
        }
        if (entry == null) return; // 迟到/未知响应按后到忽略。
        String type = message.optString("type");
        if (entry.observer) {
            try {
                entry.callback.onError.accept(bridgeException(message));
            } catch (Throwable ignored) {
            }
        } else if ("error".equals(type)) {
            entry.future.completeExceptionally(bridgeException(message));
        } else {
            Object result = message.opt("result");
            try {
                JSONObject envelope = new JSONObject().put("type", "result").put("id", id)
                        .put("result", result == null ? JSONObject.NULL : result);
                entry.future.complete(envelope);
            } catch (JSONException e) {
                terminate(new BridgeException("PROTOCOL", "invalid", "响应封装失败"));
            }
        }
    }

    private void handleFrame(JSONObject message) {
        String id = message.optString("id");
        JSONObject frame = message.optJSONObject("frame");
        if (id.isEmpty() || frame == null) {
            terminate(new BridgeException("PROTOCOL", "invalid", "帧格式无效"));
            return;
        }
        Pending entry;
        synchronized (lock) {
            entry = pending.get(id);
        }
        if (entry == null) return;
        if (!entry.observer) {
            terminate(new BridgeException("PROTOCOL", "invalid", "帧归属无效"));
            return;
        }
        boolean terminal = "end".equals(frame.optString("type"))
                || ("client".equals(initMode) && isClientTerminal(frame));
        try {
            entry.callback.onFrame.accept(frame);
        } catch (Throwable t) {
            try {
                entry.callback.onError.accept(t);
            } catch (Throwable ignored) {
            }
        }
        if (terminal) {
            synchronized (lock) {
                if (pending.get(id) == entry) {
                    pending.remove(id);
                    activeObservers--;
                }
            }
        }
    }

    /**
     * client 模式的观察帧是 DesktopObservationEvent {type:'event',observationId,frame|error}：
     * 带 error 或内层 frame.type=end 即终态。
     */
    private static boolean isClientTerminal(JSONObject event) {
        if (!"event".equals(event.optString("type"))) return false;
        if (event.has("error") && !event.isNull("error")) return true;
        JSONObject inner = event.optJSONObject("frame");
        return inner != null && "end".equals(inner.optString("type"));
    }

    private void handleClosed(JSONObject message) {
        if (!message.optString("id").equals(shutdownId)) return;
        synchronized (lock) {
            if (finished) return;
            shutdownMatched = true;
        }
        // 不在 reader 等待 exit；严格 graceful 判定交给收尾线程。
        requestCleanup(true, new BridgeException("CLOSED", "closed", "子进程已响应关闭"));
    }

    CompletableFuture<Void> close() {
        synchronized (lock) {
            if (finished) return closeFuture;
            if (closeRequested) return closeFuture;
            closeRequested = true; // 立即停止受理新请求/观察。
        }
        Thread closer = new Thread(this::runClose, "bot-host-close");
        closer.setDaemon(true);
        closer.start();
        return closeFuture;
    }

    private void runClose() {
        try {
            if (!spawnLatch.await(CLOSE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                terminate(new BridgeException("SHUTDOWN_TIMEOUT", "not-graceful", "关闭等待启动超时"));
                return;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            terminate(new BridgeException("SHUTDOWN_TIMEOUT", "not-graceful", "关闭被中断"));
            return;
        }
        synchronized (lock) {
            if (finished) return;
        }
        if (process == null) {
            terminate(new BridgeException("CLOSED", "not-sent", "Host 未能启动"));
            return;
        }
        String id = UUID.randomUUID().toString();
        synchronized (lock) {
            shutdownId = id;
            closeDeadlineNanos = System.nanoTime() + CLOSE_TIMEOUT_MS * 1_000_000L;
        }
        try {
            JSONObject frame = new JSONObject().put("type", "shutdown").put("id", id);
            enqueue(new Frame(frame.toString().getBytes(StandardCharsets.UTF_8), null));
        } catch (IOException | JSONException e) {
            terminate(new BridgeException("CLOSED", "unconfirmed", "关闭发送失败"));
            return;
        }
        try {
            scheduler.schedule(() -> {
                if (!closeFuture.isDone()) {
                    terminate(new BridgeException("SHUTDOWN_TIMEOUT", "not-graceful", "关闭等待超时"));
                }
            }, CLOSE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            // 已进入收尾，closeFuture 由 finish 完成。
        }
    }

    private void finish(boolean graceful, BridgeException failure) {
        List<Pending> requestsToFail = new ArrayList<>();
        List<Pending> observersToFail = new ArrayList<>();
        synchronized (lock) {
            if (finished) return;
            finished = true;
            closeRequested = true;
            for (Pending entry : pending.values()) {
                if (entry.observer) observersToFail.add(entry);
                else requestsToFail.add(entry);
            }
            pending.clear();
            activeRequests = 0;
            activeObservers = 0;
        }
        if (scheduler != null) scheduler.shutdownNow();
        // 1) 等 spawn 结局：不假确认；spawnLatch 必由创建线程发布。
        if (!spawnOutcome) {
            try {
                spawnLatch.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        // 2) 真实收割：必须等到 exit/reap 已知才允许完成闭环。
        int code = -1;
        boolean reaped = true;
        Process p = process;
        if (p != null) {
            if (!graceful && p.isAlive()) {
                forcedDestroy = true;
                try {
                    p.destroy();
                } catch (Throwable ignored) {
                }
            }
            try {
                boolean exited = exitLatch.await(EXIT_AWAIT_MS, TimeUnit.MILLISECONDS);
                if (!exited && p.isAlive()) {
                    forcedDestroy = true;
                    try {
                        p.destroyForcibly();
                    } catch (Throwable ignored) {
                    }
                    exited = exitLatch.await(EXIT_AWAIT_MS, TimeUnit.MILLISECONDS);
                }
                if (exited) {
                    code = childExitCode;
                } else {
                    reaped = false;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                reaped = false;
            }
            try {
                p.getOutputStream().close();
            } catch (IOException ignored) {
            }
            try {
                p.getInputStream().close();
            } catch (IOException ignored) {
            }
            try {
                p.getErrorStream().close();
            } catch (IOException ignored) {
            }
        }
        // 限时等待传输线程退出，避免仅守护线程遗弃。
        Thread current = Thread.currentThread();
        for (Thread thread : transportThreads) {
            if (thread != current) {
                try {
                    thread.join(500);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }
        boolean effectiveGraceful = graceful && reaped && code == 0 && !forcedDestroy;
        BridgeException terminalFailure = failure;
        if (!effectiveGraceful && !reaped) {
            terminalFailure = new BridgeException("CLEANUP_FAILED", "not-graceful", "无法回收子进程");
        }
        for (Pending entry : requestsToFail) {
            if (entry.timer != null) entry.timer.cancel(false);
            if (!entry.future.isDone()) {
                entry.future.completeExceptionally(new BridgeException(
                        terminalFailure.code, entry.sent ? "unconfirmed" : "not-sent", terminalFailure.getMessage()));
            }
        }
        for (Pending entry : observersToFail) {
            try {
                entry.callback.onError.accept(terminalFailure);
            } catch (Throwable ignored) {
            }
        }
        if (!launchFuture.isDone()) {
            launchFuture.completeExceptionally(effectiveGraceful
                    ? new BridgeException("CANCELLED", "cancelled", "Host未就绪即关闭")
                    : terminalFailure);
        }
        if (effectiveGraceful) closeFuture.complete(null);
        else closeFuture.completeExceptionally(terminalFailure);
        debugLog("finish exitCode=" + code + " graceful=" + effectiveGraceful);
        if (reaped) {
            // 已确认实际退出，可直接通知一次。
            if (exitNotified.compareAndSet(false, true)) {
                try {
                    listener.onExit(this, code, effectiveGraceful);
                } catch (Throwable ignored) {
                }
            }
        } else {
            // 尚未实际退出：closeFuture 已以 CLEANUP_FAILED 完成，后台继续等待 exitLatch，
            // 在真正退出后通知一次，绝不提前通知后丢失后续退出。
            Thread notifier = new Thread(() -> {
                try {
                    exitLatch.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                boolean g = shutdownMatched && childExitCode == 0 && !forcedDestroy;
                if (exitNotified.compareAndSet(false, true)) {
                    try {
                        listener.onExit(this, childExitCode, g);
                    } catch (Throwable ignored) {
                    }
                }
            }, "bot-host-exit-notify");
            notifier.setDaemon(true);
            notifier.start();
        }
    }

    /** org.json 的 JSONObject(String) 不拒绝尾随垃圾，改用 Tokener 严格取整文档。 */
    private static JSONObject parseFrame(String text) throws IOException {
        JSONTokener tokener = new JSONTokener(text);
        Object value;
        boolean clean;
        try {
            value = tokener.nextValue();
            clean = tokener.nextClean() == 0;
        } catch (JSONException e) {
            throw new IOException("帧 JSON 解析失败");
        }
        if (!(value instanceof JSONObject) || !clean) {
            throw new IOException("帧 JSON 解析失败");
        }
        return (JSONObject) value;
    }

    private static BridgeException bridgeException(JSONObject message) {
        String code = message.optString("code", "ERROR");
        String outcome = message.optString("outcome", "responded");
        String raw = message.optString("message", "");
        return new BridgeException(code, outcome, sanitize(raw));
    }

    private static BridgeException toBridge(Throwable cause) {
        if (cause instanceof BridgeException) return (BridgeException) cause;
        if (cause instanceof JSONException) return new BridgeException("LAUNCH_FAILED", "not-sent", "协议帧无效");
        return new BridgeException("LAUNCH_FAILED", "not-sent", "内部错误");
    }

    private static String sanitize(String text) {
        if (text == null) return "";
        StringBuilder sb = new StringBuilder(text.length());
        for (int i = 0; i < text.length() && sb.length() < 200; i++) {
            char c = text.charAt(i);
            if (c >= 0x20 && c != 0x7F) sb.append(c);
        }
        return sb.toString();
    }

    private static final class Pending {
        final String id;
        final boolean observer;
        boolean connection;
        final CompletableFuture<JSONObject> future;
        final Observer callback;
        volatile boolean sent;
        volatile ScheduledFuture<?> timer;

        Pending(String id, boolean observer, CompletableFuture<JSONObject> future, Observer callback) {
            this.id = id;
            this.observer = observer;
            this.future = future;
            this.callback = callback;
        }
    }

    private static final class Observer {
        final Consumer<JSONObject> onFrame;
        final Consumer<Throwable> onError;

        Observer(Consumer<JSONObject> onFrame, Consumer<Throwable> onError) {
            this.onFrame = onFrame;
            this.onError = onError;
        }
    }

    /** 有界逐行读取：UTF-8 原始行 ≤ maxLine（含空白），超限抛错。 */
    private static final class BoundedLineReader {
        private final int maxLine;
        private byte[] buffer = new byte[65536];
        private int fill;
        private int scan;
        private int lineStart;

        BoundedLineReader(int maxLine) {
            this.maxLine = maxLine;
        }

        byte[] readLine(InputStream in) throws IOException {
            while (true) {
                if (scan < fill) {
                    for (; scan < fill; scan++) {
                        if (buffer[scan] == '\n') {
                            int length = scan - lineStart;
                            if (length > maxLine) throw new IOException("帧超限");
                            byte[] line = new byte[length];
                            System.arraycopy(buffer, lineStart, line, 0, length);
                            lineStart = scan + 1;
                            scan = lineStart;
                            return line;
                        }
                    }
                }
                if (fill - lineStart > maxLine) throw new IOException("帧超限");
                if (lineStart > 0) {
                    System.arraycopy(buffer, lineStart, buffer, 0, fill - lineStart);
                    fill -= lineStart;
                    scan = 0;
                    lineStart = 0;
                }
                if (fill == buffer.length) {
                    int nextSize = buffer.length * 2;
                    if (nextSize > maxLine + 1) nextSize = maxLine + 1;
                    byte[] grown = new byte[nextSize];
                    System.arraycopy(buffer, 0, grown, 0, fill);
                    buffer = grown;
                }
                int count = in.read(buffer, fill, buffer.length - fill);
                if (count < 0) {
                    if (fill == lineStart) return null;
                    int length = fill - lineStart;
                    if (length > maxLine) throw new IOException("帧超限");
                    byte[] last = new byte[length];
                    System.arraycopy(buffer, lineStart, last, 0, length);
                    fill = lineStart;
                    scan = lineStart;
                    return last;
                }
                fill += count;
            }
        }
    }
}
