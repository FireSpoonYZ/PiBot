package com.example.launcherprobe;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/** 分发 Node Host 原生工具调用（android_apps/android_shower/shower_surface/android_speak）到本机资源。 */
final class BotHostNativeTools {
    private static final int MAX_ACCEPTED_WORK = 8;
    private static final int WORKER_THREADS = 4;
    private static final int WORK_QUEUE_CAPACITY = 4;
    private static final int AUX_QUEUE_CAPACITY = 32;
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final int MAX_TEXT_OUTPUT_BYTES = 50 * 1024;
    private static final Set<String> TOOLS = Set.of("android_apps", "android_shower", "android_speak",
            "schedule_task", "shower_surface");
    private static final Set<String> KINDS = Set.of("primary", "room", "dm");
    /** 人工操控没有 durable task：manager 传 'human:'+UUID；仅 shower_surface 允许，其他工具仍是正安全整数。 */
    private static final Pattern HUMAN_TASK_ID = Pattern.compile("human:[0-9a-fA-F-]{8,64}");

    /** 与 android-bridge-protocol.js、BotHostProcess 同一严格语义的人工 taskId 检查。 */
    static boolean isHumanTaskId(Object value) {
        return value instanceof String text && HUMAN_TASK_ID.matcher(text).matches();
    }

    private final Context appContext;
    private final ShowerToolBridge showerTools;
    private final AppCatalog appCatalog;
    private final BotHostVoice voice;
    private final ThreadPoolExecutor workers;
    private final ThreadPoolExecutor aux;
    private final ThreadPoolExecutor cleaner;
    private final Map<String, Task> tasks = new ConcurrentHashMap<>();
    private final AtomicBoolean closed = new AtomicBoolean();
    private volatile BotHostProcess boundProcess;
    private volatile String deviceId;

    BotHostNativeTools(Context context, BotHostVoice voice) {
        this.appContext = context.getApplicationContext();
        this.voice = voice;
        showerTools = new ShowerToolBridge(context);
        appCatalog = new AppCatalog(context);
        workers = new ThreadPoolExecutor(WORKER_THREADS, WORKER_THREADS, 0L,
                TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(WORK_QUEUE_CAPACITY),
                new ThreadFactory() {
            private int serial;
            @Override public synchronized Thread newThread(Runnable r) {
                Thread thread = new Thread(r, "bot-host-native-" + (++serial));
                thread.setDaemon(true);
                return thread;
            }
        });
        aux = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(AUX_QUEUE_CAPACITY), new ThreadFactory() {
            private int serial;
            @Override public synchronized Thread newThread(Runnable r) {
                Thread thread = new Thread(r, "bot-host-native-aux-" + (++serial));
                thread.setDaemon(true);
                return thread;
            }
        });
        cleaner = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(1), new ThreadFactory() {
            @Override public synchronized Thread newThread(Runnable r) {
                Thread thread = new Thread(r, "bot-host-native-cleanup");
                thread.setDaemon(true);
                return thread;
            }
        });
    }

    /** 一代绑定：onReady 返回前由宿主调用一次；之后仅接受该进程、该设备号的帧。 */
    void bind(BotHostProcess process, String deviceId) {
        this.boundProcess = process;
        this.deviceId = deviceId;
    }

    /** reader 线程回调，非阻塞：只校验、入队并回送即时错误，不做任何有界等待。 */
    void onFrame(BotHostProcess process, JSONObject frame) {
        if (closed.get() || process != boundProcess || frame == null) return;
        String type = frame.optString("type");
        if ("native_cancel".equals(type)) {
            cancel(frame.optString("id"));
            return;
        }
        if (!"native_call".equals(type)) return;
        String id = frame.optString("id");
        if (id.isEmpty() || process.readyInfo() == null || !process.isAlive()) {
            if (!id.isEmpty()) sendErrorAsync(process, id, "ANDROID_NATIVE_UNAVAILABLE",
                    "Host 尚未就绪或已关闭，暂不接收原生调用");
            return;
        }
        Task task = new Task(id, process, frame);
        Task raced = tasks.putIfAbsent(id, task);
        if (raced != null) return; // 重复帧忽略。
        if (tasks.size() > MAX_ACCEPTED_WORK) {
            tasks.remove(id, task);
            sendErrorAsync(process, id, "ANDROID_NATIVE_BUSY", "原生调用并发已满");
            return;
        }
        String invalid = validate(frame);
        if (invalid != null) {
            tasks.remove(id, task);
            sendErrorAsync(process, id, "ANDROID_NATIVE_ERROR", invalid);
            return;
        }
        try {
            task.future = workers.submit(task);
            if (task.cancelled.get()) task.future.cancel(true);
        } catch (RejectedExecutionException exception) {
            tasks.remove(id, task);
            sendErrorAsync(process, id, "ANDROID_NATIVE_BUSY", "原生调用并发已满");
        }
    }

    private String validate(JSONObject frame) {
        if (!TOOLS.contains(frame.optString("tool"))) return "未知原生工具";
        Object arguments = frame.opt("arguments");
        if (arguments != null && !(arguments instanceof JSONObject)) return "参数必须是对象";
        JSONObject context = frame.optJSONObject("context");
        if (context == null) return "缺少调用上下文";
        if (deviceId == null || !deviceId.equals(context.optString("deviceId"))) return "调用设备与当前代不符";
        if (context.optString("botId").isEmpty()) return "缺少 botId";
        if (context.optString("conversationId").isEmpty()) return "缺少 conversationId";
        String kind = context.optString("kind");
        if (!KINDS.contains(kind)) return "kind 无效";
        if ("primary".equals(kind)) {
            if (context.has("scopeId") && !context.isNull("scopeId")) return "primary 不应携带 scopeId";
        } else if (!context.has("scopeId") || context.isNull("scopeId")
                || context.optString("scopeId").isEmpty()) {
            return "work 调用缺少 scopeId";
        }
        if ("shower_surface".equals(frame.optString("tool"))) {
            JSONObject showerArguments = frame.optJSONObject("arguments");
            if (showerArguments == null || showerArguments.optString("action").isEmpty()
                    || showerArguments.optString("source").isEmpty()) {
                return "shower_surface 缺少 action 或 source";
            }
            if (context.opt("taskId") instanceof String) {
                return isHumanTaskId(context.opt("taskId")) ? null : "taskId 无效";
            }
        }
        if (!(context.opt("taskId") instanceof Number number)) return "taskId 必须是正整数";
        double value = number.doubleValue();
        long rounded = Math.round(value);
        if (value != rounded || rounded <= 0 || rounded > MAX_SAFE_INTEGER) {
            return "taskId 必须是安全正整数";
        }
        return null;
    }

    private void cancel(String id) {
        Task task = tasks.remove(id);
        if (task == null) return;
        task.cancelled.set(true);
        Future<?> future = task.future;
        if (future != null) future.cancel(true);
    }

    void close() {
        if (!closed.compareAndSet(false, true)) return;
        BotHostSchedules schedules = BotHostSchedules.instanceIfPresent();
        if (schedules != null && boundProcess != null) schedules.unbind(boundProcess);
        for (Task task : tasks.values()) {
            if (tasks.remove(task.id, task)) {
                task.cancelled.set(true);
                Future<?> future = task.future;
                if (future != null) future.cancel(true);
            }
        }
        try {
            cleaner.execute(() -> {
                showerTools.shutdown();
                workers.shutdownNow();
            });
        } catch (RejectedExecutionException exception) {
            // closed CAS 保证每代最多一次清理；兜底为单次 daemon 线程，绝不阻塞调用线程。
            Thread thread = new Thread(() -> {
                showerTools.shutdown();
                workers.shutdownNow();
            }, "bot-host-native-cleanup");
            thread.setDaemon(true);
            thread.start();
        }
    }

    /** 有界回执执行器；满载时不创建新线程，而是关闭捕获进程触发统一关闭路径。 */
    private void runAsync(Runnable action, BotHostProcess fallbackClose) {
        try {
            aux.execute(action);
        } catch (RejectedExecutionException exception) {
            if (fallbackClose != null) fallbackClose.close();
        }
    }

    private void sendErrorAsync(BotHostProcess process, String id, String code, String message) {
        runAsync(() -> sendError(process, id, code, message), process);
    }

    private void sendError(BotHostProcess process, String id, String code, String message) {
        try {
            process.sendNativeResult(new JSONObject().put("type", "native_result")
                    .put("id", id)
                    .put("error", new JSONObject().put("code", code).put("message", message)));
        } catch (IOException | RuntimeException | JSONException ignored) {
            // 传输或 JSON 失败由宿主统一关闭路径处理。
        }
    }

    private final class Task implements Runnable {
        final String id;
        final BotHostProcess process;
        final JSONObject frame;
        final AtomicBoolean cancelled = new AtomicBoolean();
        volatile Future<?> future;
        private Thread runner; // 受 this 保护：只在 execute 期间非空，避免中断复用线程上的其他任务。

        Task(String id, BotHostProcess process, JSONObject frame) {
            this.id = id;
            this.process = process;
            this.frame = frame;
        }

        synchronized void interruptIfRunning() {
            if (runner != null) runner.interrupt();
        }

        @Override public void run() {
            if (closed.get() || cancelled.get()) return;
            Object result = null;
            JSONObject error = null;
            synchronized (this) { runner = Thread.currentThread(); }
            try {
                result = execute(frame, cancelled);
            } catch (Throwable t) {
                error = fixedError(t);
            } finally {
                synchronized (this) { runner = null; }
                Thread.interrupted(); // 接管中断只针对本次执行，不泄漏到回执写入或下一个任务。
            }
            if (closed.get() || cancelled.get()) return;
            if (!tasks.remove(id, this)) return; // 已被取消而抑制回执。
            try {
                JSONObject reply = new JSONObject().put("type", "native_result").put("id", id);
                if (error != null) reply.put("error", error);
                else reply.put("result", result);
                process.sendNativeResult(reply);
            } catch (IOException | RuntimeException | JSONException ignored) {
                // 传输或 JSON 失败由宿主统一关闭路径处理。
            }
        }
    }

    private Object execute(JSONObject frame, AtomicBoolean cancelled) throws Exception {
        String tool = frame.optString("tool");
        JSONObject arguments = frame.optJSONObject("arguments");
        if (arguments == null) arguments = new JSONObject();
        JSONObject context = frame.getJSONObject("context");
        return switch (tool) {
            case "android_apps" -> apps(arguments);
            case "android_shower" -> shower(context, arguments, cancelled::get);
            case "shower_surface" -> ShowerSurfaceBridge.execute(showerTools, context, arguments,
                    cancelled::get);
            case "android_speak" -> speak(arguments);
            case "schedule_task" -> BotHostSchedules.get(appContext)
                    .applyTool(boundProcess, context, arguments, cancelled);
            default -> throw new IllegalArgumentException("未知原生工具");
        };
    }

    private JSONArray apps(JSONObject arguments) throws Exception {
        JSONArray apps = appCatalog.execute(arguments);
        if (apps.toString().getBytes(StandardCharsets.UTF_8).length > MAX_TEXT_OUTPUT_BYTES) {
            throw new IllegalStateException("应用列表文本超过 50 KiB，请改用 search 关键词缩小范围");
        }
        return apps;
    }

    private JSONObject shower(JSONObject context, JSONObject arguments, BooleanSupplier cancelled)
            throws Exception {
        String ownerKey = ShowerToolBridge.ownerKey(context.optString("deviceId"),
                context.optString("botId"));
        return showerTools.executeOwner(ownerKey, arguments, cancelled);
    }

    /** Bot 屏幕面板：只读取当前代该 Bot 已有的屏幕，不创建。 */
    ShowerController screenController(String botId) {
        String device = deviceId;
        if (closed.get() || device == null || botId == null || botId.isEmpty()) return null;
        return showerTools.existingController(ShowerToolBridge.ownerKey(device, botId));
    }

    /**
     * 接管：中断该 Bot 正在执行的屏幕工具（滑动等可取消动作随即停止）。被中断的调用照常回执错误；
     * 尚未开始的调用由控制器的 userDirty 标记拒绝非截图动作，因此不在这里静默取消（否则 Node 收不到回执）。
     */
    void interruptShower(String botId) {
        if (botId == null || botId.isEmpty()) return;
        for (Task task : tasks.values()) {
            if (!"android_shower".equals(task.frame.optString("tool"))) continue;
            JSONObject context = task.frame.optJSONObject("context");
            if (context != null && botId.equals(context.optString("botId"))) task.interruptIfRunning();
        }
    }

    private JSONObject speak(JSONObject arguments) throws Exception {
        Object value = arguments.opt("text");
        if (!(value instanceof String text) || text.isEmpty() || text.length() > 10000) {
            throw new IllegalArgumentException("text 必须是 1..10000 字符的文本");
        }
        CompletableFuture<JSONObject> accepted = voice.speak(text);
        try {
            return accepted.get();
        } catch (InterruptedException interrupted) {
            accepted.cancel(true);
            throw interrupted;
        } catch (java.util.concurrent.ExecutionException execution) {
            if (execution.getCause() instanceof java.util.concurrent.CancellationException) {
                accepted.cancel(true);
                throw (java.util.concurrent.CancellationException) execution.getCause();
            }
            throw execution;
        }
    }

    /**
     * 固定安全错误对象；不暴露任意 cause/凭据/正文文本。shower_surface 的已分类失败
     * 保留共享协议错误码，后端才能区分 SHOWER_UNSUPPORTED / SHOWER_SESSION_MISMATCH 等。
     */
    private static JSONObject fixedError(Throwable t) {
        ShowerSurfaceBridge.Failure surface = surfaceFailure(t);
        try {
            if (surface != null) {
                return new JSONObject().put("code", surface.code).put("message", surface.getMessage());
            }
            return new JSONObject().put("code", "ANDROID_NATIVE_ERROR").put("message", message(t));
        } catch (RuntimeException | JSONException exception) {
            try {
                return new JSONObject().put("code", "ANDROID_NATIVE_ERROR")
                        .put("message", "系统内部错误");
            } catch (RuntimeException | JSONException ignored) {
                // 常量构造仍失败（理论不可达）时返回空对象，保证非空 JSON 结果边界。
                return new JSONObject();
            }
        }
    }

    private static ShowerSurfaceBridge.Failure surfaceFailure(Throwable t) {
        Throwable cause = t;
        while (cause != null) {
            if (cause instanceof ShowerSurfaceBridge.Failure failure) return failure;
            if (cause.getCause() == cause) break;
            cause = cause.getCause();
        }
        return null;
    }

    private static String message(Throwable t) {
        Throwable cause = t;
        while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
        if (cause instanceof InterruptedException
                || cause instanceof java.util.concurrent.CancellationException) {
            return "已取消";
        }
        if (cause instanceof IllegalArgumentException) return "工具参数无效";
        if (cause instanceof IllegalStateException) return "工具状态无效，操作未执行";
        if (cause instanceof IOException) return "本机资源或传输错误";
        return "系统内部错误";
    }
}
