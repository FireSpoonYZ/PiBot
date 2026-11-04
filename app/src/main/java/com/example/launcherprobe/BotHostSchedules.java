package com.example.launcherprobe;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.ZoneId;
import java.util.Arrays;
import java.util.Iterator;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * M16 Host 定时任务引擎（新独占命名空间 files/bot-host/schedules.sqlite）。
 * 全部数据库/事务/日历/闹钟 IO 与调度状态运行在专用单线程执行器上；
 * 生命周期锁（connLock）仅保护连接引用交换，bind/unbind 非阻塞、无 IO。
 * 每次 occurrence 发送前先持久化 claimed 标记并提交，之后绝不重发 submit；
 * 已尝试 run 仅按原 requestId 只读对账，定义删除/更新/禁用不影响对账。
 */
final class BotHostSchedules {

    static final String ACTION_RUN = "com.example.launcherprobe.BOT_HOST_SCHEDULE_RUN";

    private static final int STATE_VERSION = 1;
    private static final int MAX_TASKS = 100;
    private static final int MAX_ACTIVE_RUNS = 32;
    private static final int MAX_TOTAL_RUNS = 100;
    private static final int DEFAULT_LIST_LIMIT = 20;
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final long WAKE_INTERVAL_MS = 30_000L;
    private static final long RETRY_DELAY_MS = 5_000L;
    private static final String SOURCE_PREFIX = "Scheduled task; not an authenticated human message";
    private static final String EXACT_NOT_GRANTED = "未授予精确闹钟权限，exact 闹钟未安装";
    private static final String ALARM_SCHEDULE_FAILED = "闹钟安排失败，任务已保存但可能无法准时触发";
    private static final int REQ_EXACT = 0;
    private static final int REQ_ALARM_CLOCK = 1;
    private static final int REQ_SHOW = 2;

    private static final Set<String> REPEATS = Set.of("once", "daily", "weekly", "monthly",
            "statutoryWorkday", "statutoryHoliday");
    private static final Set<String> TERMINAL_RUNS = Set.of("done", "unanswered", "not_sent",
            "skipped_offline", "skipped_capacity");
    private static final Set<String> ACTIVE_RUNS = Set.of("dispatching", "unconfirmed", "queued", "placed");
    private static final Set<String> SUBMISSION_TERMINAL = Set.of("done", "unanswered");
    private static final Set<String> SUBMISSION_ACTIVE = Set.of("queued", "placed");
    private static final Set<String> CREATE_FIELDS = Set.of("action", "title", "prompt", "repeat", "time",
            "weekday", "weekdays", "monthDay", "alarmMode", "vibrate", "deleteAfterRun");
    private static final Set<String> UPDATE_FIELDS = Set.of("action", "id", "revision", "title", "prompt",
            "repeat", "time", "weekday", "weekdays", "monthDay", "alarmMode", "vibrate", "deleteAfterRun");
    private static final Set<String> MUTATION_ID_FIELDS = Set.of("action", "id", "revision");
    private static final Set<String> ENABLE_FIELDS = Set.of("action", "id", "revision", "enabled");
    private static final Set<String> LIST_FIELDS = Set.of("action", "cursor", "limit");

    private static volatile BotHostSchedules instance;

    static synchronized BotHostSchedules get(Context context) {
        if (instance == null) instance = new BotHostSchedules(context.getApplicationContext());
        return instance;
    }

    /** 不构造；未初始化返回 null。 */
    static synchronized BotHostSchedules instanceIfPresent() {
        return instance;
    }

    /** 事务回调：允许 checked JSONException，inTx 边界统一映射固定存储错误。 */
    @FunctionalInterface
    private interface TxAction<T> {
        T apply(SQLiteDatabase db) throws Exception;
    }

    private static final class Connection {
        final BotHostManager manager;
        final BotHostProcess process;
        final String deviceId;
        boolean ready; // 仅执行器线程访问：初始 reconcile 成功提交后才为 true

        Connection(BotHostManager manager, BotHostProcess process, String deviceId) {
            this.manager = manager;
            this.process = process;
            this.deviceId = deviceId;
            this.ready = false;
        }
    }

    /** 已验证 native context 的持久 actor tuple（权限边界）。 */
    private static final class Owner {
        final String deviceId;
        final String botId;
        final String conversationId;

        Owner(String deviceId, String botId, String conversationId) {
            this.deviceId = deviceId;
            this.botId = botId;
            this.conversationId = conversationId;
        }
    }

    private static final class Inflight {
        final Connection connection;
        final String runId;
        final String kind; // submit | getSubmission

        Inflight(Connection connection, String runId, String kind) {
            this.connection = connection;
            this.runId = runId;
            this.kind = kind;
        }
    }

    private static final class Step {
        final Inflight inflight;
        final JSONObject run; // 计划时捕获的不可变 occurrence 快照（含 prompt/owner/requestId）

        Step(Inflight inflight, JSONObject run) {
            this.inflight = inflight;
            this.run = run;
        }
    }

    private static final class State {
        final JSONObject json;
        final JSONArray tasks;
        final JSONArray runs;
        String schedulingError;

        State(JSONObject json) throws JSONException {
            this.json = json;
            this.tasks = json.getJSONArray("tasks");
            this.runs = json.getJSONArray("runs");
            this.schedulingError = json.optString("schedulingError");
        }
    }

    private final Context context;
    private final Object connLock = new Object();
    private final ScheduledExecutorService executor;
    private volatile Connection conn;
    private SQLiteDatabase db; // 仅执行器线程访问
    private ScheduleCalendar calendarCached; // 仅执行器线程访问
    private ScheduledFuture<?> wakeFuture; // 仅执行器线程访问
    private Inflight inflight; // 仅执行器线程访问
    private int lastPlanIndex; // 仅执行器线程访问：round-robin 公平起点

    private BotHostSchedules(Context context) {
        this.context = context;
        this.executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "bot-host-schedules");
            thread.setDaemon(true);
            return thread;
        });
    }

    // ---------- 生命周期：bind/unbind（非阻塞，仅换引用，IO 后台） ----------

    /** 同一进程幂等；死进程拒绝绑定（锁内判定，防迟到旧 ready 覆盖新代）；只同步换连接引用。 */
    void bind(BotHostManager manager, BotHostProcess process, String deviceId) {
        if (process == null) return;
        Connection bound = new Connection(manager, process, deviceId);
        synchronized (connLock) {
            if (!process.isAlive()) return;
            Connection c = conn;
            if (c != null && c.process == process) return;
            conn = bound;
        }
        executor.execute(() -> reconcile(bound));
    }

    /** 只解除匹配进程；非阻塞；后台清理仅在无新代时取消闹钟/清 timer/清旧 inflight。 */
    void unbind(BotHostProcess process) {
        synchronized (connLock) {
            Connection c = conn;
            if (c == null || c.process != process) return;
            conn = null;
        }
        executor.execute(() -> {
            synchronized (connLock) {
                if (conn != null) return; // 新代已绑定：状态交给其自身 reconcile
                if (wakeFuture != null) {
                    wakeFuture.cancel(false);
                    wakeFuture = null;
                }
                if (inflight != null) inflight = null;
            }
            cancelAlarms();
        });
    }

    /** 闹钟触发：捕获 Connection，后台执行；仅当仍当前绑定且 ready 才处理。 */
    void onAlarm() {
        Connection c;
        synchronized (connLock) {
            c = conn;
        }
        if (c == null) return;
        executor.execute(() -> {
            synchronized (connLock) {
                if (conn != c || !c.ready) return;
            }
            dispatchDueAndReschedule(c);
        });
    }

    /** 系统时间/时区/精确闹钟权限变化：捕获 Connection，后台重算；不补发旧 occurrence。 */
    void onClockChanged() {
        Connection c;
        synchronized (connLock) {
            c = conn;
        }
        if (c == null) return;
        executor.execute(() -> {
            synchronized (connLock) {
                if (conn != c || !c.ready) return;
            }
            try {
                inTx(db -> {
                    State st = load(db);
                    markMissedLocked(st);
                    save(db, st);
                    scheduleAlarmsLocked(st);
                    save(db, st);
                    return null;
                });
            } catch (Throwable failure) {
                log("clock-reconcile-failed");
            }
            drive(c);
        });
    }

    // ---------- 原生工具入口：排队到执行器后阻塞等待 ----------

    /** NativeTools worker 线程调用；排队执行，生成/归属在队列入口重检。 */
    JSONObject applyTool(BotHostProcess expected, JSONObject actorContext, JSONObject input,
                         AtomicBoolean cancelled) throws Exception {
        if (cancelled != null && cancelled.get()) throw new CancellationException();
        Connection expectedConn;
        synchronized (connLock) {
            expectedConn = conn;
        }
        if (expectedConn == null || expectedConn.process != expected) {
            throw new IllegalStateException("Host 未绑定");
        }
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        try {
            executor.execute(() -> {
                try {
                    if (cancelled != null && cancelled.get()) {
                        future.completeExceptionally(new CancellationException());
                        return;
                    }
                    // 队列入口重检：连接仍为期望连接且初始 reconcile 已成功才允许变更。
                    synchronized (connLock) {
                        if (conn != expectedConn || !expectedConn.ready) {
                            future.completeExceptionally(new IllegalStateException("Host 未绑定"));
                            return;
                        }
                    }
                    JSONObject out = executeOperation(expectedConn, actorContext, input);
                    if (cancelled != null && cancelled.get()) {
                        future.completeExceptionally(new CancellationException());
                        return;
                    }
                    future.complete(out);
                } catch (Throwable t) {
                    future.completeExceptionally(t);
                }
            });
        } catch (RejectedExecutionException e) {
            throw new IllegalStateException("调度繁忙");
        }
        try {
            return future.get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            future.cancel(true);
            throw new CancellationException();
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof RuntimeException) throw (RuntimeException) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw new IllegalStateException("内部错误");
        }
    }

    private JSONObject executeOperation(Connection c, JSONObject actorContext, JSONObject input) {
        if (actorContext == null) throw new IllegalArgumentException("缺少调用上下文");
        String deviceId = actorContext.optString("deviceId");
        if (deviceId.isEmpty() || !deviceId.equals(c.deviceId)) throw new IllegalArgumentException("设备与当前代不符");
        String botId = actorContext.optString("botId");
        String conversationId = actorContext.optString("conversationId");
        if (botId.isEmpty() || conversationId.isEmpty()) throw new IllegalArgumentException("缺少主私聊身份");
        String kind = actorContext.optString("kind");
        Object scope = actorContext.opt("scopeId");
        if ("primary".equals(kind)) {
            if (!(scope == null || actorContext.isNull("scopeId"))) throw new IllegalArgumentException("primary 不应携带 scopeId");
        } else if ("room".equals(kind) || "dm".equals(kind)) {
            if (scope == null || actorContext.isNull("scopeId") || actorContext.optString("scopeId").isEmpty()) {
                throw new IllegalArgumentException("work 调用缺少 scopeId");
            }
        } else {
            throw new IllegalArgumentException("kind 无效");
        }
        Object taskIdObj = actorContext.opt("taskId");
        if (!(taskIdObj instanceof Number) || ((Number) taskIdObj).longValue() <= 0
                || ((Number) taskIdObj).doubleValue() > MAX_SAFE_INTEGER
                || ((Number) taskIdObj).doubleValue() != Math.floor(((Number) taskIdObj).doubleValue())) {
            throw new IllegalArgumentException("taskId 无效");
        }
        long sourceTaskId = ((Number) taskIdObj).longValue();
        if (input == null || input.length() == 0) throw new IllegalArgumentException("缺少参数");
        String action = input.optString("action");
        if (action.isEmpty()) throw new IllegalArgumentException("缺少 action");
        Owner owner = new Owner(deviceId, botId, conversationId);
        switch (action) {
            case "create":
                requireKeys(input, CREATE_FIELDS);
                return create(owner, input, sourceTaskId);
            case "update":
                requireKeys(input, UPDATE_FIELDS);
                return update(owner, input);
            case "delete":
                requireKeys(input, MUTATION_ID_FIELDS);
                return delete(owner, input);
            case "setEnabled":
                requireKeys(input, ENABLE_FIELDS);
                return setEnabled(owner, input);
            case "list":
                requireKeys(input, LIST_FIELDS);
                return list(owner, input);
            case "requestExactAlarm":
                return requestExactAlarmFromBridge();
            case "pauseBot":
                return pauseOwner(owner);
            case "deleteBot":
                return deleteOwner(owner);
            default:
                throw new IllegalArgumentException("未知操作");
        }
    }

    /** UI 管理入口：在专用调度执行器内按指定 Bot 主会话归属执行列表/创建/编辑/启停/删除/闹钟授权。 */
    CompletableFuture<JSONObject> applyUi(String deviceId, String botId, String conversationId, JSONObject input) {
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        try {
            executor.execute(() -> {
                try {
                    if (input == null || input.length() == 0) {
                        throw new IllegalArgumentException("缺少参数");
                    }
                    String action = input.optString("action");
                    if ("requestExactAlarm".equals(action)) {
                        if (Build.VERSION.SDK_INT >= 31 && !exactAlarmGranted()) {
                            context.startActivity(new Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                                    android.net.Uri.parse("package:" + context.getPackageName()))
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                        }
                        future.complete(new JSONObject()
                                .put("requested", true)
                                .put("exactAlarmGranted", exactAlarmGranted()));
                        return;
                    }
                    if (deviceId == null || deviceId.isEmpty() || botId == null || botId.isEmpty()
                            || conversationId == null || conversationId.isEmpty()) {
                        throw new IllegalArgumentException("缺少 Bot 主私聊身份");
                    }
                    Owner owner = new Owner(deviceId, botId, conversationId);
                    JSONObject result = switch (action) {
                        case "create" -> {
                            requireKeys(input, CREATE_FIELDS);
                            yield enrichPrompt(create(owner, input, 1L));
                        }
                        case "update" -> {
                            requireKeys(input, UPDATE_FIELDS);
                            yield enrichPrompt(update(owner, input));
                        }
                        case "delete" -> {
                            requireKeys(input, MUTATION_ID_FIELDS);
                            yield delete(owner, input);
                        }
                        case "setEnabled" -> {
                            requireKeys(input, ENABLE_FIELDS);
                            yield enrichPrompt(setEnabled(owner, input));
                        }
                        case "list" -> {
                            requireKeys(input, LIST_FIELDS);
                            yield enrichPrompt(list(owner, input));
                        }
                        default -> throw new IllegalArgumentException("未知操作");
                    };
                    future.complete(result);
                } catch (Throwable t) {
                    future.completeExceptionally(t);
                }
            });
        } catch (RejectedExecutionException e) {
            future.completeExceptionally(new IllegalStateException("调度繁忙"));
        }
        return future;
    }

    /** UI 列表与编辑需要读取完整 prompt；原生工具路径的 taskDTO 保持原字段不变。 */
    private JSONObject enrichPrompt(JSONObject result) {
        return inTx(db -> {
            State st = load(db);
            JSONObject single = result.optJSONObject("task");
            if (single != null) {
                JSONObject stored = findTask(st, single.optString("id"));
                if (stored != null && stored.has("prompt")) {
                    single.put("prompt", stored.optString("prompt"));
                }
            }
            JSONArray list = result.optJSONArray("tasks");
            if (list != null) {
                for (int i = 0; i < list.length(); i++) {
                    JSONObject dto = list.getJSONObject(i);
                    JSONObject stored = findTask(st, dto.optString("id"));
                    if (stored != null && stored.has("prompt")) {
                        dto.put("prompt", stored.optString("prompt"));
                    }
                }
            }
            return result;
        });
    }

    private JSONObject requestExactAlarmFromBridge() {
        try {
            if (Build.VERSION.SDK_INT >= 31 && !exactAlarmGranted()) {
                context.startActivity(new Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                        android.net.Uri.parse("package:" + context.getPackageName()))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            }
            return new JSONObject()
                    .put("requested", true)
                    .put("exactAlarmGranted", exactAlarmGranted());
        } catch (JSONException e) {
            throw new IllegalStateException("定时任务操作失败");
        }
    }

    private JSONObject pauseOwner(Owner owner) {
        return inTx(db -> {
            State st = load(db);
            long now = System.currentTimeMillis();
            boolean changed = false;
            for (int i = 0; i < st.tasks.length(); i++) {
                JSONObject task = st.tasks.getJSONObject(i);
                if (ownerMatches(task, owner) && task.optBoolean("enabled", true)) {
                    task.put("enabled", false);
                    task.put("nextRunAt", 0L);
                    task.put("revision", task.optLong("revision", 1L) + 1L);
                    task.put("updatedAt", now);
                    changed = true;
                }
            }
            if (changed) {
                save(db, st);
                scheduleAlarmsLocked(st);
                save(db, st);
            }
            return new JSONObject().put("paused", true);
        });
    }

    private JSONObject deleteOwner(Owner owner) {
        return inTx(db -> {
            State st = load(db);
            boolean removed = false;
            for (int i = st.tasks.length() - 1; i >= 0; i--) {
                JSONObject task = st.tasks.getJSONObject(i);
                if (ownerMatches(task, owner)) {
                    st.tasks.remove(i);
                    removed = true;
                }
            }
            long now = System.currentTimeMillis();
            for (int i = 0; i < st.runs.length(); i++) {
                JSONObject run = st.runs.getJSONObject(i);
                if (ownerMatches(run, owner) && "dispatching".equals(run.optString("status"))
                        && !run.optBoolean("submitted", false)) {
                    run.put("status", "skipped_offline");
                    run.put("reason", "task_deleted");
                    run.put("finishedAt", now);
                    run.put("submitted", true);
                }
            }
            save(db, st);
            if (removed) {
                scheduleAlarmsLocked(st);
                save(db, st);
            }
            return new JSONObject().put("deleted", true);
        });
    }

    // ---------- 工具操作 ----------

    private JSONObject create(Owner owner, JSONObject input, long sourceTaskId) {
        return inTx(db -> {
            State st = load(db);
            if (st.tasks.length() >= MAX_TASKS) throw new IllegalStateException("任务数已达上限");
            long now = System.currentTimeMillis();
            ZoneId zone = ZoneId.systemDefault();
            String id = UUID.randomUUID().toString();
            JSONObject task = newTask(owner, input, id, sourceTaskId, now, zone);
            st.tasks.put(task);
            save(db, st);
            scheduleAlarmsLocked(st);
            save(db, st);
            return mutationResult(st, task);
        });
    }

    private JSONObject update(Owner owner, JSONObject input) {
        return inTx(db -> {
            State st = load(db);
            String id = requiredId(input);
            long revision = requiredRevision(input);
            int index = indexOfTask(st, owner, id);
            if (index < 0) throw new IllegalStateException("任务不存在");
            JSONObject task = st.tasks.getJSONObject(index);
            if (task.optLong("revision") != revision) throw new IllegalStateException("任务已被修改，请刷新后重试");
            JSONObject merged = new JSONObject(task.toString());
            Iterator<String> keys = input.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if ("action".equals(key) || "id".equals(key) || "revision".equals(key)) continue;
                merged.put(key, input.get(key));
            }
            // weekday/weekdays 互斥合并：更新其一须清除另一，避免旧规则静默生效。
            if (input.has("weekday") && !input.has("weekdays")) merged.remove("weekdays");
            if (input.has("weekdays") && !input.has("weekday")) merged.remove("weekday");
            validateTaskFields(merged);
            long now = System.currentTimeMillis();
            ZoneId zone = ZoneId.systemDefault();
            if (merged.optBoolean("enabled", true)) {
                merged.put("nextRunAt", nextAfter(merged, now, zone));
            } else {
                merged.put("nextRunAt", 0L); // 禁用定义不继续触发
            }
            merged.put("revision", revision + 1);
            merged.put("updatedAt", now);
            st.tasks.put(index, merged);
            save(db, st);
            scheduleAlarmsLocked(st);
            save(db, st);
            return mutationResult(st, merged);
        });
    }

    private JSONObject delete(Owner owner, JSONObject input) {
        return inTx(db -> {
            State st = load(db);
            String id = requiredId(input);
            long revision = requiredRevision(input);
            int index = indexOfTask(st, owner, id);
            if (index < 0) throw new IllegalStateException("任务不存在");
            if (st.tasks.getJSONObject(index).optLong("revision") != revision) {
                throw new IllegalStateException("任务已被修改，请刷新后重试");
            }
            st.tasks.remove(index);
            save(db, st);
            scheduleAlarmsLocked(st);
            save(db, st);
            try {
                return alarmStatus(st, ZoneId.systemDefault()).put("deleted", id);
            } catch (JSONException impossible) {
                throw new IllegalStateException("响应构造失败");
            }
        });
    }

    private JSONObject setEnabled(Owner owner, JSONObject input) {
        return inTx(db -> {
            State st = load(db);
            String id = requiredId(input);
            long revision = requiredRevision(input);
            Object enabledObj = input.opt("enabled");
            if (!(enabledObj instanceof Boolean)) throw new IllegalArgumentException("enabled 必须是布尔值");
            int index = indexOfTask(st, owner, id);
            if (index < 0) throw new IllegalStateException("任务不存在");
            JSONObject task = st.tasks.getJSONObject(index);
            if (task.optLong("revision") != revision) throw new IllegalStateException("任务已被修改，请刷新后重试");
            JSONObject merged = new JSONObject(task.toString());
            merged.put("enabled", enabledObj);
            long now = System.currentTimeMillis();
            ZoneId zone = ZoneId.systemDefault();
            if ((Boolean) enabledObj) {
                if (merged.optLong("nextRunAt") <= now) {
                    merged.put("nextRunAt", nextAfter(merged, now, zone));
                }
            } else {
                merged.put("nextRunAt", 0L);
            }
            merged.put("revision", revision + 1);
            merged.put("updatedAt", now);
            st.tasks.put(index, merged);
            save(db, st);
            scheduleAlarmsLocked(st);
            save(db, st);
            return mutationResult(st, merged);
        });
    }

    private JSONObject list(Owner owner, JSONObject input) {
        return inTx(db -> {
            State st = load(db);
            String cursor = null;
            if (input.has("cursor")) {
                cursor = canonicalUuid(input.optString("cursor"));
            }
            int limit = DEFAULT_LIST_LIMIT;
            if (input.has("limit")) {
                Object raw = input.opt("limit");
                if (!(raw instanceof Number) || ((Number) raw).doubleValue() != ((Number) raw).intValue()
                        || ((Number) raw).intValue() < 1 || ((Number) raw).intValue() > 50) {
                    throw new IllegalArgumentException("limit 必须是 1..50 的整数");
                }
                limit = ((Number) raw).intValue();
            }
            JSONArray matched = new JSONArray();
            for (int i = 0; i < st.tasks.length(); i++) {
                JSONObject task = st.tasks.getJSONObject(i);
                if (!ownerMatches(task, owner)) continue;
                String id = task.optString("id");
                if (cursor != null && id.compareTo(cursor) <= 0) continue;
                matched.put(task);
            }
            String[] ids = new String[matched.length()];
            for (int i = 0; i < ids.length; i++) ids[i] = matched.getJSONObject(i).optString("id");
            Arrays.sort(ids);
            int count = Math.min(limit, ids.length);
            String nextCursor = null;
            if (count < ids.length) nextCursor = ids[count - 1]; // 仅当仍有剩余匹配任务
            JSONArray page = new JSONArray();
            for (int i = 0; i < count; i++) {
                page.put(taskDTO(findTaskById(matched, ids[i]), st.runs));
            }
            ZoneId zone = ZoneId.systemDefault();
            try {
                JSONObject result = alarmStatus(st, zone).put("tasks", page);
                result.put("nextCursor", nextCursor == null ? JSONObject.NULL : nextCursor);
                describeStatutory(result, page, zone);
                return result;
            } catch (JSONException impossible) {
                throw new IllegalStateException("响应构造失败");
            }
        });
    }

    // ---------- 触发、claim 与状态机 ----------

    private void dispatchDueAndReschedule(Connection c) {
        synchronized (connLock) {
            if (conn != c || !c.ready) return;
        }
        try {
            inTx(db -> {
                State st = load(db);
                long now = System.currentTimeMillis();
                ZoneId zone = ZoneId.systemDefault();
                for (int i = 0; i < st.tasks.length(); i++) {
                    JSONObject task = st.tasks.getJSONObject(i);
                    if (!task.optBoolean("enabled", true)) continue;
                    long due = task.optLong("nextRunAt");
                    if (due <= 0 || due > now) continue;
                    dispatchOccurrence(st, task, due, now, zone);
                }
                save(db, st);
                scheduleAlarmsLocked(st);
                save(db, st);
                return null;
            });
        } catch (Throwable failure) {
            log("dispatch-failed");
        }
        drive(c);
    }

    /** 到期 occurrence：持久化带不可变快照的 run 并推进 nextRunAt（once 禁用）。 */
    private void dispatchOccurrence(State st, JSONObject task, long due, long now, ZoneId zone)
            throws JSONException {
        String taskId = task.optString("id");
        long revision = task.optLong("revision");
        JSONObject run = newRun(taskId, task, due, revision);
        if (activeRunCount(st) >= MAX_ACTIVE_RUNS) {
            run.put("status", "skipped_capacity").put("reason", "capacity")
                    .put("finishedAt", now).put("submitted", true);
        } else {
            run.put("status", "dispatching").put("submitted", false);
        }
        st.runs.put(run);
        trimRuns(st);
        if ("once".equals(task.optString("repeat"))) {
            task.put("enabled", false).put("nextRunAt", 0L);
        } else {
            task.put("nextRunAt", nextAfter(task, now, zone));
        }
    }

    /** bind 对账：已过期 occurrence 记 skipped_offline 并推进重复规则；不补执行。 */
    private void markMissedLocked(State st) throws JSONException {
        long now = System.currentTimeMillis();
        ZoneId zone = ZoneId.systemDefault();
        for (int i = 0; i < st.tasks.length(); i++) {
            JSONObject task = st.tasks.getJSONObject(i);
            if (!task.optBoolean("enabled", true)) continue;
            long due = task.optLong("nextRunAt");
            if (due <= 0 || due > now) continue;
            JSONObject run = newRun(task.optString("id"), task, due, task.optLong("revision"));
            run.put("status", "skipped_offline").put("reason", "offline")
                    .put("finishedAt", now).put("submitted", true);
            st.runs.put(run);
            trimRuns(st);
            if ("once".equals(task.optString("repeat"))) {
                task.put("enabled", false).put("nextRunAt", 0L);
            } else {
                task.put("nextRunAt", nextAfter(task, now, zone));
            }
        }
    }

    private void reconcile(Connection bound) {
        synchronized (connLock) {
            if (conn != bound) return; // 已换代或已解除
            if (wakeFuture != null) {
                wakeFuture.cancel(false);
                wakeFuture = null;
            }
            if (inflight != null) inflight = null; // 清理旧代 inflight 引用
        }
        boolean committed = false;
        try {
            inTx(db -> {
                State st = load(db);
                neutralizeNeverAttempted(st);
                markMissedLocked(st);
                save(db, st);
                scheduleAlarmsLocked(st);
                save(db, st);
                return null;
            });
            committed = true;
        } catch (Throwable failure) {
            log("bind-reconcile-failed");
        }
        synchronized (connLock) {
            if (!committed || conn != bound) return; // 提交失败或已换代：不 ready、不驱动
            bound.ready = true;
        }
        drive(bound);
    }

    /** 事务内闭环所有从未尝试发送（submitted=false）的 dispatching 遗留 run；已尝试 run 保留对账。 */
    private void neutralizeNeverAttempted(State st) throws JSONException {
        long now = System.currentTimeMillis();
        for (int i = 0; i < st.runs.length(); i++) {
            JSONObject run = st.runs.getJSONObject(i);
            if (!"dispatching".equals(run.optString("status")) || run.optBoolean("submitted")) continue;
            run.put("status", "skipped_offline").put("reason", "offline")
                    .put("finishedAt", now).put("submitted", true);
            st.runs.put(i, run);
        }
    }

    // ---------- 驱动：单 timer、round-robin 公平、至多一个进行中 RPC ----------

    private void drive(Connection c) {
        while (true) {
            synchronized (connLock) {
                if (conn != c || !c.ready) return; // 换代/未 ready 停止
            }
            if (inflight != null) return; // 已有一个进行中查询/提交
            if (wakeFuture != null) {
                wakeFuture.cancel(false);
                wakeFuture = null;
            }
            Step step = planStepLocked(c);
            if (step == null) {
                scheduleWakeIfActive(c);
                return;
            }
            inflight = step.inflight;
            if (!executeStep(step)) return; // claim 失败已限速重试，避免热循环
        }
    }

    /** 事务内规划：round-robin 扫描；定义已删且从未尝试的 run 在同一事务内闭环。 */
    private Step planStepLocked(Connection c) {
        try {
            return inTx(db -> {
                State st = load(db);
                JSONArray runs = st.runs;
                int n = runs.length();
                if (n == 0) return null;
                int start = (lastPlanIndex + 1) % n;
                for (int k = 0; k < n; k++) {
                    int i = (start + k) % n;
                    JSONObject run = runs.getJSONObject(i);
                    String status = run.optString("status");
                    boolean submitted = run.optBoolean("submitted");
                    String runId = run.optString("id");
                    if ("dispatching".equals(status) && !submitted) {
                        if (findTask(st, run.optString("taskId")) == null) {
                            // 定义已删且从未尝试发送：按离线错过终态闭环，不发送。
                            run.put("status", "skipped_offline").put("reason", "task_deleted")
                                    .put("finishedAt", System.currentTimeMillis()).put("submitted", true);
                            st.runs.put(i, run);
                            save(db, st);
                            continue;
                        }
                        lastPlanIndex = i;
                        return new Step(new Inflight(c, runId, "submit"), run);
                    }
                    if (submitted && ("unconfirmed".equals(status) || SUBMISSION_ACTIVE.contains(status))) {
                        lastPlanIndex = i;
                        return new Step(new Inflight(c, runId, "getSubmission"), run);
                    }
                }
                return null;
            });
        } catch (Throwable failure) {
            log("plan-failed");
            return null;
        }
    }

    private boolean executeStep(Step step) {
        if ("submit".equals(step.inflight.kind)) {
            // claim 前核连接/ready；claim 后若连接已变，保留 unconfirmed 标记且不发送。
            synchronized (connLock) {
                if (conn != step.inflight.connection || !step.inflight.connection.ready) {
                    inflight = null;
                    return true;
                }
            }
            // 第一次且唯一一次 submit 前：原子 claim（持久化 submitted=true/unconfirmed 并提交），
            // 绝不重发已完成 claim 的 run；存储失败则本次不发送任何 Node 输入，限速重试。
            if (!claimPreSend(step)) {
                inflight = null;
                scheduleRetry(step.inflight.connection);
                return false;
            }
            synchronized (connLock) {
                if (conn != step.inflight.connection || !step.inflight.connection.ready) {
                    inflight = null;
                    return true; // 绑定已变：不发送，留给新代 getSubmission 对账
                }
            }
        }
        String method;
        JSONObject params;
        try {
            if ("submit".equals(step.inflight.kind)) {
                method = "submit";
                String text = SOURCE_PREFIX + " " + step.run.optString("prompt");
                params = new JSONObject().put("botId", ownerBotId(step.run))
                        .put("requestId", step.run.optString("requestId")).put("text", text);
            } else {
                method = "getSubmission";
                params = new JSONObject().put("botId", ownerBotId(step.run))
                        .put("requestId", step.run.optString("requestId"));
            }
        } catch (JSONException impossible) {
            settle(step, null, new IllegalStateException("请求构造失败"));
            return true;
        }
        CompletableFuture<JSONObject> future;
        try {
            future = step.inflight.connection.manager.scheduleCall(
                    step.inflight.connection.process, method, params);
        } catch (Throwable failure) {
            settle(step, null, failure);
            return true;
        }
        future.whenComplete((envelope, error) -> executor.execute(() -> settle(step, envelope, error)));
        return true;
    }

    /** 发送前持久标记：事务内验证 run 仍为未 claim 的 dispatching，置 submitted=true/unconfirmed。 */
    private boolean claimPreSend(Step step) {
        try {
            return inTx(db -> {
                State st = load(db);
                int index = indexOfRun(st, step.inflight.runId);
                if (index < 0) return false;
                JSONObject run = st.runs.getJSONObject(index);
                if (!"dispatching".equals(run.optString("status")) || run.optBoolean("submitted")) return false;
                run.put("submitted", true).put("status", "unconfirmed");
                st.runs.put(index, run);
                save(db, st);
                return true;
            });
        } catch (Throwable failure) {
            log("claim-failed");
            return false;
        }
    }

    private void settle(Step step, JSONObject envelope, Throwable error) {
        synchronized (connLock) {
            if (inflight != step.inflight) return; // 迟到旧代回执/重复 settle 忽略
            inflight = null;
            if (conn != step.inflight.connection) return; // 换代：旧 settle 直接返回，新代 reconcile 负责驱动
        }
        final boolean[] deletedRef = {false};
        final boolean[] vibrateRef = {false};
        String status = null;
        try {
            status = inTx(db -> {
                State st = load(db);
                int index = indexOfRun(st, step.inflight.runId);
                if (index < 0) return null;
                JSONObject run = st.runs.getJSONObject(index);
                if (error != null) {
                    applyError(run, step.inflight.kind, error);
                } else {
                    applyEnvelope(run, step.inflight.kind, envelope);
                }
                st.runs.put(index, run);
                save(db, st);
                if ("done".equals(run.optString("status"))) {
                    vibrateRef[0] = run.optBoolean("vibrate", false);
                    deletedRef[0] = finishDoneLocked(st, run); // 终态先持久化
                    save(db, st);
                }
                return run.optString("status");
            });
        } catch (Throwable failure) {
            log("settle-failed");
        }
        // 仅 commit 成功且连接仍当前时才振动；判断用 volatile conn 快照，振动在生命周期锁外执行。
        boolean stillCurrent = false;
        if (status != null && vibrateRef[0]) {
            synchronized (connLock) {
                stillCurrent = conn == step.inflight.connection;
            }
        }
        if (stillCurrent) {
            vibrateShort();
        }
        if (deletedRef[0]) {
            try {
                inTx(db -> {
                    State st = load(db);
                    scheduleAlarmsLocked(st); // 删除引起闹钟重算
                    save(db, st);
                    return null;
                });
            } catch (Throwable failure) {
                log("reschedule-after-delete-failed");
            }
        }
        if (status != null && ACTIVE_RUNS.contains(status)) {
            scheduleRetry(step.inflight.connection);
        } else {
            drive(step.inflight.connection);
        }
    }

    private void applyError(JSONObject run, String kind, Throwable error) throws JSONException {
        Throwable root = unwrap(error);
        if ("submit".equals(kind) && root instanceof BotHostProcess.BridgeException bridge
                && "not-sent".equals(bridge.outcome)) {
            run.put("status", "not_sent").put("reason", "not_sent")
                    .put("finishedAt", System.currentTimeMillis());
        } else {
            // 错误/timeout/进程切换：保原 ID，绝不自动重发 submit，留 unconfirmed 只读对账。
            run.put("status", "unconfirmed").put("submitted", true);
        }
        run.put("updatedAt", System.currentTimeMillis());
    }

    private void applyEnvelope(JSONObject run, String kind, JSONObject envelope) throws JSONException {
        long now = System.currentTimeMillis();
        if (envelope == null || !"result".equals(envelope.optString("type"))
                || !(envelope.opt("result") instanceof JSONObject)) {
            run.put("status", "unconfirmed").put("submitted", true).put("updatedAt", now);
            return;
        }
        JSONObject result = envelope.optJSONObject("result");
        // getSubmission 返回 null 不能证明原 submit 未执行：保 unconfirmed，不 POST。
        if ("getSubmission".equals(kind) && result.length() == 0) {
            run.put("status", "unconfirmed").put("submitted", true).put("updatedAt", now);
            return;
        }
        if (!ownerBotId(run).equals(result.optString("botId"))
                || !ownerConversationId(run).equals(result.optString("conversationId"))
                || !run.optString("requestId").equals(result.optString("requestId"))) {
            run.put("status", "unconfirmed").put("submitted", true).put("updatedAt", now);
            return;
        }
        String status = result.optString("status");
        if (status.isEmpty() || (!SUBMISSION_TERMINAL.contains(status) && !SUBMISSION_ACTIVE.contains(status))) {
            run.put("status", "unconfirmed").put("submitted", true).put("updatedAt", now);
            return;
        }
        Object submissionId = result.opt("submissionId");
        if (!(submissionId instanceof Number) || ((Number) submissionId).doubleValue() <= 0
                || ((Number) submissionId).doubleValue() > MAX_SAFE_INTEGER
                || ((Number) submissionId).doubleValue() != Math.floor(((Number) submissionId).doubleValue())) {
            run.put("status", "unconfirmed").put("submitted", true).put("updatedAt", now);
            return;
        }
        run.put("submissionStatus", status).put("submissionId", submissionId);
        if (SUBMISSION_TERMINAL.contains(status)) {
            run.put("status", status).put("finishedAt", now);
        } else {
            run.put("status", status);
        }
        run.put("submitted", true).put("updatedAt", now);
    }

    /** done 终态处理（事务内）：仅当现定义 owner/revision 匹配 run 快照才 deleteAfterRun；振动由 settle 在 commit 后执行。 */
    private boolean finishDoneLocked(State st, JSONObject run) throws JSONException {
        boolean deleted = false;
        JSONObject task = findTask(st, run.optString("taskId"));
        if (task != null && task.optLong("revision") == run.optLong("revision")
                && ownerEq(task, run)) {
            if (run.optBoolean("deleteAfterRun", false)) {
                int index = indexOfTask(st, null, run.optString("taskId"));
                if (index >= 0) {
                    st.tasks.remove(index);
                    deleted = true;
                }
            }
        }
        return deleted;
    }

    private static Throwable unwrap(Throwable t) {
        Throwable cur = t;
        while (cur instanceof java.util.concurrent.CompletionException || cur instanceof ExecutionException) {
            Throwable cause = cur.getCause();
            if (cause == null || cause == cur) break;
            cur = cause;
        }
        return cur;
    }

    // ---------- 存储 ----------

    private <T> T inTx(TxAction<T> action) {
        SQLiteDatabase database = db(); // 仅执行器线程访问，天然串行
        database.beginTransaction();
        try {
            T result = action.apply(database);
            database.setTransactionSuccessful();
            return result;
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("定时任务存储操作失败");
        } finally {
            database.endTransaction();
        }
    }

    private SQLiteDatabase db() {
        if (db == null) openDbLocked();
        return db;
    }

    /** 原子初始化：仅全新文件建表/行（CREATE_IF_NECESSARY）；现有库严格校验，不修复、不 reset、不删损坏库。 */
    private void openDbLocked() {
        File file = new File(context.getFilesDir(), "bot-host/schedules.sqlite");
        File dir = file.getParentFile();
        if (dir != null && !dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("定时任务存储目录创建失败");
        }
        boolean fresh = !file.exists();
        int flags = SQLiteDatabase.OPEN_READWRITE
                | (fresh ? SQLiteDatabase.CREATE_IF_NECESSARY : 0);
        SQLiteDatabase opened = SQLiteDatabase.openDatabase(file.getAbsolutePath(), null, flags,
                db -> {
                    throw new IllegalStateException("定时任务存储损坏"); // 自定义 NO-DELETE 损坏处理
                });
        try {
            if (fresh) {
                opened.beginTransaction();
                try {
                    opened.execSQL("CREATE TABLE state(id INTEGER NOT NULL PRIMARY KEY,"
                            + " version INTEGER NOT NULL, json TEXT NOT NULL)");
                    String initial = "{\"version\":1,\"tasks\":[],\"runs\":[],"
                            + "\"schedulingError\":\"\",\"timeZone\":\"\"}";
                    opened.execSQL("INSERT INTO state(id,version,json) VALUES(1,?,?)",
                            new Object[]{STATE_VERSION, initial});
                    opened.setTransactionSuccessful();
                } finally {
                    opened.endTransaction();
                }
            } else {
                // 现有库：复用 load(opened) 严格校验；绝不在现有库上重建缺失状态。
                load(opened);
            }
            db = opened;
        } catch (RuntimeException failure) {
            try {
                opened.close();
            } catch (RuntimeException ignored) {
            }
            throw failure;
        }
    }

    /** 小元数据走 Cursor（全表恰一行、id/version 均 INTEGER 且精确 1/STATE_VERSION）；大 JSON 行用 SQLiteStatement 读取。 */
    private State load(SQLiteDatabase database) {
        try (android.database.Cursor cursor = database.rawQuery(
                "SELECT id,version FROM state", null)) {
            if (!cursor.moveToFirst() || !cursor.isLast()) {
                throw new IllegalStateException("定时任务存储缺失");
            }
            if (cursor.getType(0) != android.database.Cursor.FIELD_TYPE_INTEGER
                    || cursor.getLong(0) != 1L) {
                throw new IllegalStateException("定时任务存储缺失");
            }
            if (cursor.getType(1) != android.database.Cursor.FIELD_TYPE_INTEGER
                    || cursor.getLong(1) != STATE_VERSION) {
                throw new IllegalStateException("定时任务存储版本不受支持");
            }
        }
        String json;
        try (SQLiteStatement statement = database.compileStatement(
                "SELECT json FROM state WHERE id=1")) {
            json = statement.simpleQueryForString();
        }
        return parseState(json);
    }

    /** JSON 版本精确校验：拒绝缺失/强转/分数；任务与 run 必须是数组。 */
    private State parseState(String json) {
        try {
            JSONObject parsed = new JSONObject(json);
            Object v = parsed.opt("version");
            if (!(v instanceof Number) || ((Number) v).doubleValue() != STATE_VERSION
                    || ((Number) v).doubleValue() != ((Number) v).intValue()) {
                throw new IllegalStateException("定时任务存储版本不受支持");
            }
            if (!(parsed.opt("tasks") instanceof JSONArray) || !(parsed.opt("runs") instanceof JSONArray)) {
                throw new IllegalStateException("定时任务存储损坏");
            }
            return new State(parsed);
        } catch (JSONException failure) {
            throw new IllegalStateException("定时任务存储损坏");
        }
    }

    private void save(SQLiteDatabase database, State st) {
        try {
            st.json.put("tasks", st.tasks).put("runs", st.runs)
                    .put("schedulingError", st.schedulingError)
                    .put("timeZone", ZoneId.systemDefault().getId());
            database.execSQL("UPDATE state SET version=?, json=? WHERE id=1",
                    new Object[]{STATE_VERSION, st.json.toString()});
        } catch (JSONException failure) {
            throw new IllegalStateException("定时任务存储序列化失败");
        }
    }

    // ---------- 闹钟 ----------

    private void scheduleAlarmsLocked(State st) throws JSONException {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        PendingIntent exactOp = operation(REQ_EXACT);
        PendingIntent clockOp = operation(REQ_ALARM_CLOCK);
        alarms.cancel(exactOp);
        alarms.cancel(clockOp);
        if (conn == null) {
            st.schedulingError = "";
            return;
        }
        long exactNext = Long.MAX_VALUE;
        long clockNext = Long.MAX_VALUE;
        for (int i = 0; i < st.tasks.length(); i++) {
            JSONObject task = st.tasks.getJSONObject(i);
            if (!task.optBoolean("enabled", true)) continue;
            long due = task.optLong("nextRunAt");
            if (due <= 0) continue;
            if ("exact".equals(task.optString("alarmMode", "alarmClock")) && due < exactNext) exactNext = due;
            if ("alarmClock".equals(task.optString("alarmMode", "alarmClock")) && due < clockNext) clockNext = due;
        }
        st.schedulingError = "";
        if (exactNext != Long.MAX_VALUE) {
            if (exactAlarmGranted()) {
                try {
                    alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, exactNext, exactOp);
                } catch (RuntimeException failure) {
                    log("exact-alarm-failed");
                    st.schedulingError = ALARM_SCHEDULE_FAILED;
                }
            } else {
                st.schedulingError = EXACT_NOT_GRANTED;
            }
        }
        if (clockNext != Long.MAX_VALUE) {
            try {
                PendingIntent show = PendingIntent.getActivity(context, REQ_SHOW,
                        new Intent(context, TauriMainActivity.class)
                                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                alarms.setAlarmClock(new AlarmManager.AlarmClockInfo(clockNext, show), clockOp);
            } catch (RuntimeException failure) {
                log("alarm-clock-failed");
                st.schedulingError = ALARM_SCHEDULE_FAILED;
            }
        }
    }

    private void cancelAlarms() {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        alarms.cancel(operation(REQ_EXACT));
        alarms.cancel(operation(REQ_ALARM_CLOCK));
    }

    private PendingIntent operation(int requestCode) {
        return PendingIntent.getBroadcast(context, requestCode,
                new Intent(context, BotHostScheduleReceiver.class).setAction(ACTION_RUN),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private boolean exactAlarmGranted() {
        return Build.VERSION.SDK_INT < 31
                || context.getSystemService(AlarmManager.class).canScheduleExactAlarms();
    }

    /** 单一跟踪 wake timer：仅在存在未终态 run 且仍绑定当前代时安排。 */
    private void scheduleWakeIfActive(Connection c) {
        boolean hasActive = false;
        try {
            State st = load(db());
            for (int i = 0; i < st.runs.length(); i++) {
                if (ACTIVE_RUNS.contains(st.runs.getJSONObject(i).optString("status"))) {
                    hasActive = true;
                    break;
                }
            }
        } catch (Throwable failure) {
            log("wake-plan-failed");
            return;
        }
        synchronized (connLock) {
            if (conn != c || !c.ready) return;
            if (wakeFuture != null) wakeFuture.cancel(false);
            if (hasActive) {
                wakeFuture = executor.schedule(() -> drive(c), WAKE_INTERVAL_MS, TimeUnit.MILLISECONDS);
            }
        }
    }

    private void scheduleRetry(Connection c) {
        synchronized (connLock) {
            if (conn != c || !c.ready) return;
            if (wakeFuture != null) wakeFuture.cancel(false);
            wakeFuture = executor.schedule(() -> drive(c), RETRY_DELAY_MS, TimeUnit.MILLISECONDS);
        }
    }

    // ---------- 字段与校验 ----------

    private static void requireKeys(JSONObject input, Set<String> allowed) {
        Iterator<String> keys = input.keys();
        while (keys.hasNext()) {
            if (!allowed.contains(keys.next())) throw new IllegalArgumentException("未知参数");
        }
    }

    private static String requiredId(JSONObject input) {
        return canonicalUuid(input.optString("id"));
    }

    private static long requiredRevision(JSONObject input) {
        Object raw = input.opt("revision");
        if (!(raw instanceof Number) || ((Number) raw).doubleValue() != ((Number) raw).longValue()
                || ((Number) raw).longValue() <= 0 || ((Number) raw).doubleValue() > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("revision 必须是正整数");
        }
        return ((Number) raw).longValue();
    }

    private static String canonicalUuid(String value) {
        try {
            UUID uuid = UUID.fromString(value);
            if (uuid.toString().equals(value)) return value;
        } catch (RuntimeException ignored) {
            // fallthrough
        }
        throw new IllegalArgumentException("id 必须是规范 UUID");
    }

    private JSONObject newTask(Owner owner, JSONObject input, String id, long sourceTaskId,
                               long now, ZoneId zone) {
        try {
            JSONObject task = new JSONObject();
            task.put("id", id);
            task.put("revision", 1L);
            task.put("enabled", true);
            task.put("sourceTaskId", sourceTaskId);
            task.put("createdAt", now);
            task.put("updatedAt", now);
            task.put("owner", new JSONObject()
                    .put("deviceId", owner.deviceId)
                    .put("botId", owner.botId)
                    .put("conversationId", owner.conversationId));
            copyField(input, task, "title");
            copyField(input, task, "prompt");
            copyField(input, task, "repeat");
            copyField(input, task, "time");
            if (input.has("weekday")) copyField(input, task, "weekday");
            if (input.has("weekdays")) copyField(input, task, "weekdays");
            if (input.has("monthDay")) copyField(input, task, "monthDay");
            task.put("alarmMode", strictEnum(input, "alarmMode", "alarmClock", "exact", "alarmClock"));
            task.put("vibrate", strictBoolean(input, "vibrate", false));
            task.put("deleteAfterRun", strictBoolean(input, "deleteAfterRun", false));
            validateTaskFields(task);
            task.put("nextRunAt", nextAfter(task, now, zone));
            return task;
        } catch (JSONException impossible) {
            throw new IllegalArgumentException("参数无效");
        }
    }

    private static void copyField(JSONObject from, JSONObject to, String key) throws JSONException {
        Object value = from.opt(key);
        if (value == null || JSONObject.NULL.equals(value)) throw new IllegalArgumentException("缺少必要参数");
        to.put(key, value);
    }

    private static String strictEnum(JSONObject input, String key, String a, String b, String fallback) {
        if (!input.has(key)) return fallback;
        Object raw = input.opt(key);
        if (!(raw instanceof String) || (!a.equals(raw) && !b.equals(raw))) {
            throw new IllegalArgumentException(key + " 必须是 " + a + " 或 " + b);
        }
        return (String) raw;
    }

    private static boolean strictBoolean(JSONObject input, String key, boolean fallback) {
        if (!input.has(key)) return fallback;
        Object raw = input.opt(key);
        if (!(raw instanceof Boolean)) throw new IllegalArgumentException(key + " 必须是布尔值");
        return (Boolean) raw;
    }

    private static void validateTaskFields(JSONObject task) throws JSONException {
        Object titleRaw = task.opt("title");
        if (!(titleRaw instanceof String title) || title.isEmpty() || title.length() > 80
                || !isWellFormed(title) || title.strip().isEmpty()) {
            throw new IllegalArgumentException("title 必须是 1..80 字符的非空白文本");
        }
        Object promptRaw = task.opt("prompt");
        if (!(promptRaw instanceof String prompt) || prompt.isEmpty() || prompt.length() > 8000
                || !isWellFormed(prompt) || prompt.strip().isEmpty()) {
            throw new IllegalArgumentException("prompt 必须是 1..8000 字符的非空白文本");
        }
        Object repeatRaw = task.opt("repeat");
        if (!(repeatRaw instanceof String repeat) || !REPEATS.contains(repeat)) {
            throw new IllegalArgumentException("重复方式无效");
        }
        Object timeRaw = task.opt("time");
        if (!(timeRaw instanceof String time) || !time.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]")) {
            throw new IllegalArgumentException("时间格式无效");
        }
        Object modeRaw = task.opt("alarmMode");
        if (modeRaw != null && (!(modeRaw instanceof String)
                || (!"exact".equals(modeRaw) && !"alarmClock".equals(modeRaw)))) {
            throw new IllegalArgumentException("alarmMode 必须是 exact 或 alarmClock");
        }
        Object vibrateRaw = task.opt("vibrate");
        if (vibrateRaw != null && !(vibrateRaw instanceof Boolean)) throw new IllegalArgumentException("vibrate 必须是布尔值");
        Object deleteRaw = task.opt("deleteAfterRun");
        if (deleteRaw != null && !(deleteRaw instanceof Boolean)) throw new IllegalArgumentException("deleteAfterRun 必须是布尔值");
        if (task.has("weekday")) {
            Object raw = task.opt("weekday");
            if (!(raw instanceof Number) || ((Number) raw).doubleValue() != ((Number) raw).intValue()) {
                throw new IllegalArgumentException("weekday 必须是整数");
            }
        }
        if (task.has("weekdays")) {
            Object raw = task.opt("weekdays");
            if (!(raw instanceof JSONArray)) throw new IllegalArgumentException("weekdays 必须是数组");
            JSONArray days = (JSONArray) raw;
            for (int i = 0; i < days.length(); i++) {
                Object day = days.opt(i);
                if (!(day instanceof Number) || ((Number) day).doubleValue() != ((Number) day).intValue()) {
                    throw new IllegalArgumentException("weekdays 必须是整数数组");
                }
            }
        }
        if (task.has("monthDay")) {
            Object raw = task.opt("monthDay");
            if (!(raw instanceof Number) || ((Number) raw).doubleValue() != ((Number) raw).intValue()) {
                throw new IllegalArgumentException("monthDay 必须是整数");
            }
        }
        // 用 ScheduleRule 复用既有规则解析/校验（weekly 日、monthly monthDay 等）。
        ScheduleRule.fromJson(task);
    }

    private static boolean isWellFormed(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(i + 1))) return false;
                i++;
            } else if (Character.isLowSurrogate(c)) {
                return false;
            }
        }
        return true;
    }

    private long nextAfter(JSONObject task, long after, ZoneId zone) {
        try {
            return ScheduleRule.fromJson(task).nextAfter(after, zone, calendar());
        } catch (IllegalArgumentException failure) {
            throw failure;
        } catch (RuntimeException failure) {
            throw new IllegalArgumentException("重复规则无效");
        }
    }

    // ---------- 查询辅助 ----------

    private static JSONObject ownerOf(JSONObject value) {
        JSONObject owner = value.optJSONObject("owner");
        return owner != null ? owner : new JSONObject();
    }

    private static boolean ownerMatches(JSONObject value, Owner owner) {
        JSONObject stored = ownerOf(value);
        return owner != null && owner.deviceId.equals(stored.optString("deviceId"))
                && owner.botId.equals(stored.optString("botId"))
                && owner.conversationId.equals(stored.optString("conversationId"));
    }

    private static boolean ownerEq(JSONObject a, JSONObject b) {
        return ownerMatches(a, new Owner(ownerOf(b).optString("deviceId"),
                ownerOf(b).optString("botId"), ownerOf(b).optString("conversationId")));
    }

    private static String ownerBotId(JSONObject value) {
        return ownerOf(value).optString("botId");
    }

    private static String ownerConversationId(JSONObject value) {
        return ownerOf(value).optString("conversationId");
    }

    private JSONObject newRun(String taskId, JSONObject task, long occurrence, long revision) {
        try {
            JSONObject run = new JSONObject();
            run.put("id", UUID.randomUUID().toString());
            run.put("taskId", taskId);
            run.put("revision", revision);
            run.put("occurrence", occurrence);
            run.put("requestId", stableRequestId(taskId, revision, occurrence));
            // 不可变 occurrence 快照：提交/振动/删除不依赖后续编辑的 live 定义。
            run.put("prompt", task.optString("prompt"));
            run.put("vibrate", task.optBoolean("vibrate", false));
            run.put("deleteAfterRun", task.optBoolean("deleteAfterRun", false));
            JSONObject owner = new JSONObject();
            JSONObject taskOwner = ownerOf(task);
            owner.put("deviceId", taskOwner.optString("deviceId"));
            owner.put("botId", taskOwner.optString("botId"));
            owner.put("conversationId", taskOwner.optString("conversationId"));
            run.put("owner", owner);
            long now = System.currentTimeMillis();
            run.put("createdAt", now);
            run.put("updatedAt", now);
            return run;
        } catch (JSONException impossible) {
            throw new IllegalStateException("run 构造失败");
        }
    }

    private static String stableRequestId(String taskId, long revision, long occurrence) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            String seed = taskId + "|" + revision + "|" + occurrence;
            byte[] hash = digest.digest(seed.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(hash.length * 2);
            for (byte b : hash) sb.append(String.format("%02x", b & 0xff));
            return sb.toString();
        } catch (Exception impossible) {
            // 摘要构造失败绝不回退随机 ID（会破坏对账唯一性）。
            throw new IllegalStateException("定时任务存储操作失败");
        }
    }

    private static int activeRunCount(State st) throws JSONException {
        int count = 0;
        for (int i = 0; i < st.runs.length(); i++) {
            if (ACTIVE_RUNS.contains(st.runs.getJSONObject(i).optString("status"))) count++;
        }
        return count;
    }

    /** 只剪裁已终态 run，不丢未决 ID；总量 ≤ 100。 */
    private static void trimRuns(State st) throws JSONException {
        while (st.runs.length() > MAX_TOTAL_RUNS) {
            int oldestFinished = -1;
            for (int i = 0; i < st.runs.length(); i++) {
                if (TERMINAL_RUNS.contains(st.runs.getJSONObject(i).optString("status"))) {
                    oldestFinished = i;
                    break;
                }
            }
            if (oldestFinished < 0) break;
            st.runs.remove(oldestFinished);
        }
    }

    private static int indexOfTask(State st, Owner owner, String id) throws JSONException {
        for (int i = 0; i < st.tasks.length(); i++) {
            JSONObject task = st.tasks.getJSONObject(i);
            if (id.equals(task.optString("id")) && (owner == null || ownerMatches(task, owner))) return i;
        }
        return -1;
    }

    private static JSONObject findTask(State st, String id) {
        try {
            int index = indexOfTask(st, null, id);
            return index >= 0 ? st.tasks.getJSONObject(index) : null;
        } catch (JSONException failure) {
            return null;
        }
    }

    private static JSONObject findTaskById(JSONArray tasks, String id) throws JSONException {
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            if (id.equals(task.optString("id"))) return task;
        }
        return null;
    }

    private static int indexOfRun(State st, String id) throws JSONException {
        for (int i = 0; i < st.runs.length(); i++) {
            if (id.equals(st.runs.getJSONObject(i).optString("id"))) return i;
        }
        return -1;
    }

    private JSONObject taskDTO(JSONObject task, JSONArray runs) throws JSONException {
        JSONObject dto = new JSONObject();
        String[] keys = {"id", "revision", "enabled", "title", "prompt", "repeat", "time", "weekday", "weekdays",
                "monthDay", "alarmMode", "vibrate", "deleteAfterRun", "nextRunAt", "sourceTaskId",
                "createdAt", "updatedAt"};
        for (String key : keys) {
            if (task.has(key)) dto.put(key, task.get(key));
        }
        dto.put("latestRun", latestRun(runs, task.optString("id")));
        return dto;
    }

    private Object latestRun(JSONArray runs, String taskId) throws JSONException {
        JSONObject best = null;
        long bestOccurrence = -1;
        for (int i = 0; i < runs.length(); i++) {
            JSONObject run = runs.getJSONObject(i);
            if (!taskId.equals(run.optString("taskId"))) continue;
            long occurrence = run.optLong("occurrence");
            if (best == null || occurrence >= bestOccurrence) {
                best = run;
                bestOccurrence = occurrence;
            }
        }
        if (best == null) return JSONObject.NULL;
        JSONObject summary = new JSONObject();
        summary.put("status", best.optString("status"));
        if (best.has("submissionStatus")) summary.put("submissionStatus", best.optString("submissionStatus"));
        summary.put("occurrence", best.optLong("occurrence"));
        if (best.has("finishedAt")) summary.put("finishedAt", best.optLong("finishedAt"));
        return summary;
    }

    private JSONObject mutationResult(State st, JSONObject task) {
        ZoneId zone = ZoneId.systemDefault();
        try {
            JSONObject result = alarmStatus(st, zone).put("task", taskDTO(task, st.runs));
            JSONArray single = new JSONArray().put(task);
            describeStatutory(result, single, zone);
            return result;
        } catch (JSONException impossible) {
            throw new IllegalStateException("响应构造失败");
        }
    }

    private JSONObject alarmStatus(State st, ZoneId zone) throws JSONException {
        return new JSONObject()
                .put("exactAlarmGranted", exactAlarmGranted())
                .put("schedulingError", st.schedulingError)
                .put("timeZone", zone.getId())
                .put("now", System.currentTimeMillis());
    }

    /** 日历信息只来自本次调用返回的 tasks（list 页或 mutation 任务），绝不取他 Bot 任务。 */
    private void describeStatutory(JSONObject result, JSONArray tasks, ZoneId zone) {
        if (tasks == null || tasks.length() == 0) return;
        for (int i = 0; i < tasks.length(); i++) {
            try {
                JSONObject task = tasks.getJSONObject(i);
                ScheduleRule rule = ScheduleRule.fromJson(task);
                if (rule.isStatutory()) {
                    calendar().describe(result, rule, System.currentTimeMillis(),
                            task.optLong("nextRunAt"), zone);
                    return;
                }
            } catch (Exception ignored) {
                // 日历数据损坏：保持默认 fallback 信息。
            }
        }
    }

    private ScheduleCalendar calendar() {
        if (calendarCached == null) calendarCached = ScheduleCalendar.load(context);
        return calendarCached;
    }

    private void vibrateShort() {
        try {
            Vibrator vibrator = context.getSystemService(Vibrator.class);
            if (vibrator != null && vibrator.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= 26) {
                    vibrator.vibrate(VibrationEffect.createOneShot(200, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    vibrator.vibrate(200);
                }
            }
        } catch (RuntimeException ignored) {
            // 平台权限/服务不可用时不改变 mic/voice 策略。
        }
    }

    /** 固定阶段日志：不回显 Throwable/动态 cause。 */
    private static void log(String stage) {
        Log.e("BotHostSchedules", stage);
    }
}
