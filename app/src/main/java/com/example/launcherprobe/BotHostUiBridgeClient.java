package com.example.launcherprobe;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Parcel;
import android.os.ParcelFileDescriptor;
import android.os.RemoteException;
import android.os.SystemClock;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import org.json.JSONObject;

import java.io.Closeable;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * M18 :tauri_ui 进程到默认进程 Host 的私有桥客户端：固定 Host 数据操作 + 事件转发。
 * 不启动/停止 Host、不重放请求；saveCredentials 只把别名交给默认进程的 BotHostManager 受控转发，
 * 本层不提供任何凭据 getter、不落盘、不打印。
 * 事件在 reader 线程就有界准入后在主线程交付；onClosed 只描述本会话失败（主动 close/reconnect 不回调）。
 */
public final class BotHostUiBridgeClient {

    public interface Listener {
        /** 现有 BotHost 事件 DTO 原样（hostFrame / voiceEvent）；主线程回调。 */
        void onEvent(String event, JSONObject data);

        /** 本 UI 会话失败一次后 latch，直到显式 reconnect()；也投递在主线程。 */
        void onClosed(BridgeException error);
    }

    private static final long CONNECT_TIMEOUT_MS = 5_000L;
    /** 单请求期限：单调时钟，从请求入队起算（含排队/发送/响应）。 */
    private static final long REQUEST_DEADLINE_MS = 25_000L;
    /** 记忆方法外层等待：后端 reflect 最长 120s，留出协议/传输余量。 */
    private static final long MEMORY_REQUEST_DEADLINE_MS = 150_000L;
    /** 发送队列（排队+在写）字节预算，与 8 个请求槽独立。 */
    private static final long MAX_WRITER_BYTES = 80L * 1024 * 1024;
    /** 预留给 pause 清理的字节容量：普通请求不得把它挤掉。 */
    private static final long RESERVED_CLEANUP_BYTES = 64L * 1024;
    /** 客户端清理（clientUnobserve）独立额度：不占普通 8 槽，也不会无界排队/堆 future。 */
    private static final int MAX_CLIENT_CLEANUP_IN_FLIGHT = 2;

    private enum State { IDLE, BINDING, OPEN, FAILED, CLOSED }

    /** 请求条目：入队/写出开始/期限/字节配额同 state lock 保护；reserved 为 pause 保留槽。 */
    private static final class Job {
        final String id;
        final byte[] line;
        final boolean reserved;
        final boolean clientCleanup;
        final CompletableFuture<JSONObject> future;
        long bytes;
        boolean bytesHeld;
        long deadline;
        /** 写出时捕获的会话号；仅 wrote 为真时有意义。 */
        int session;
        boolean wrote;
        Future<?> timer;

        Job(String id, byte[] line, boolean reserved, boolean clientCleanup, CompletableFuture<JSONObject> future) {
            this.id = id;
            this.line = line;
            this.reserved = reserved;
            this.clientCleanup = clientCleanup;
            this.future = future;
        }
    }

    /** 事件投递条目：reader 线程有界准入，主线程交付期间仍占用配额，交付完才归还。 */
    private static final class Delivery {
        final int attempt;
        final String event;
        final JSONObject data;
        final int bytes;

        Delivery(int attempt, String event, JSONObject data, int bytes) {
            this.attempt = attempt;
            this.event = event;
            this.data = data;
            this.bytes = bytes;
        }
    }

    private final Context context;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    /** 需求期限计时器：取消即移除，避免 25s 任务堆积。 */
    private final ScheduledThreadPoolExecutor clock;
    /** Binder handshake 专用有界单线程：不在主线程做 transact，也不排无界任务。 */
    private final ThreadPoolExecutor handshake;
    private final Object lock = new Object();
    /** 普通请求登记（≤8）与保留 pause 槽。 */
    private final Map<String, Job> pending = new HashMap<>();
    private Job reservedPause;
    /** 待写出队列：由唯一 writer 线程消费，不持锁做 socket IO。 */
    private final ArrayDeque<Job> outbox = new ArrayDeque<>();
    /** 有界事件投递队列（≤8 帧/80MiB，含正在交付的一项）。 */
    private final List<Delivery> events = new ArrayList<>();
    private final Runnable drain = this::drainEvents;

    private State state = State.IDLE;
    private BridgeException latched;
    private ServiceConnection connection;
    private IBinder binder;
    private IBinder.DeathRecipient death;
    private ParcelFileDescriptor channel;
    private volatile OutputStream out;
    private Runnable watchdog;
    private CompletableFuture<JSONObject> connecting;
    private int attempt;
    private int failures;
    private long eventBytes;
    private long queuedBytes;
    /** 客户端观察清理当前登记数（≤ MAX_CLIENT_CLEANUP_IN_FLIGHT）。 */
    private int clientCleanupInFlight;
    private boolean draining;

    public BotHostUiBridgeClient(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
        clock = new ScheduledThreadPoolExecutor(1, runnable -> {
            Thread thread = new Thread(runnable, "bot-host-ui-bridge-timer");
            thread.setDaemon(true);
            return thread;
        });
        clock.setRemoveOnCancelPolicy(true);
        clock.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
        handshake = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(1),
                runnable -> {
                    Thread thread = new Thread(runnable, "bot-host-ui-bridge-handshake");
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
        Thread writer = new Thread(this::writeLoop, "bot-host-ui-bridge-writer");
        writer.setDaemon(true);
        writer.start();
    }

    /**
     * 固定 Host 数据操作；返回现有原生插件结果对象。失败只报错，绝不自动重发。
     * 失败会话期间新请求按 not-sent 拒绝，只有显式 reconnect() 清除。
     */
    public CompletableFuture<JSONObject> request(String method, JSONObject params) {
        if (!BotHostUiProtocol.isOperation(method)) {
            return failed(new BridgeException("INVALID_ARGUMENT", "not-sent", "不支持的操作"));
        }
        boolean reserved = BotHostUiProtocol.OP_PAUSE.equals(method);
        boolean cleanup = BotHostUiProtocol.isCleanupOperation(method);
        boolean clientCleanup = BotHostUiProtocol.isClientCleanupOperation(method);
        Job job;
        ServiceConnection bind = null;
        int session = 0;
        synchronized (lock) {
            if (state == State.CLOSED) return failed(new BridgeException("CLOSED", "not-sent", "连接已关闭"));
            if (state == State.FAILED) return failed(latchedNotSent());
            if (reserved && reservedPause != null) return reservedPause.future;
            if (clientCleanup) {
                // 清理独立额度：超限立即拒绝（不排队、不建线程），也不挤占普通登记。
                if (clientCleanupInFlight >= MAX_CLIENT_CLEANUP_IN_FLIGHT) {
                    return failed(new BridgeException("BUSY", "not-sent", "清理请求并发已满"));
                }
            } else if (!reserved
                    && pending.size() - clientCleanupInFlight >= BotHostUiProtocol.MAX_IN_FLIGHT) {
                // 普通 8 槽不挤掉 pause 的独立合并槽（pause 不占普通额度，也不被普通满载拒绝）。
                return failed(new BridgeException("BUSY", "not-sent", "请求并发已满"));
            }
            String id = UUID.randomUUID().toString();
            byte[] line;
            try {
                line = BotHostUiProtocol.line(BotHostUiProtocol.request(id, method, params));
            } catch (IOException invalid) {
                return failed(invalid);
            }
            long size = line.length + 1L;
            long limit = cleanup ? MAX_WRITER_BYTES : MAX_WRITER_BYTES - RESERVED_CLEANUP_BYTES;
            if (queuedBytes + size > limit) {
                return failed(new BridgeException("BUSY", "not-sent", "请求发送队列繁忙"));
            }
            job = new Job(id, line, reserved, clientCleanup, new CompletableFuture<>());
            job.bytes = size;
            job.bytesHeld = true;
            long deadlineMs = memoryCall(method, params) ? MEMORY_REQUEST_DEADLINE_MS : REQUEST_DEADLINE_MS;
            job.deadline = SystemClock.elapsedRealtime() + deadlineMs;
            queuedBytes += size;
            if (reserved) {
                reservedPause = job;
            } else {
                pending.put(id, job);
                if (clientCleanup) clientCleanupInFlight++;
            }
            outbox.add(job);
            try {
                job.timer = clock.schedule(() -> expire(job), deadlineMs, TimeUnit.MILLISECONDS);
            } catch (RejectedExecutionException closedClock) {
                releaseJobLocked(job);
                return failed(new BridgeException("CLOSED", "not-sent", "连接已关闭"));
            }
            if (state == State.IDLE) {
                bind = prepareBindLocked();
                session = attempt;
            }
            lock.notifyAll();
        }
        if (bind != null) connect(bind, session);
        return job.future;
    }

    /**
     * 是否为记忆方法调用：本机 call 带控制方法名，clientRequest 内层是 broker 的 call；
     * 只按确切名字判断，其余操作（含 pause/观察）期限不变。
     */
    private static boolean memoryCall(String method, JSONObject params) {
        if (params == null) return false;
        if ("call".equals(method)) return BotHostProcess.isMemoryCall(params);
        if (!"clientRequest".equals(method) || !"call".equals(params.optString("op", ""))) return false;
        return BotHostProcess.isMemoryCall(params.optJSONObject("params"));
    }

    /** 撤销本 UI 会话的观察与语音捕获；可反复调用（重复为合并），不关闭 Host/Agent、不改动已有请求结果、不重放。 */
    public void pause() {
        synchronized (lock) {
            if (state != State.OPEN && state != State.BINDING) return;
        }
        request(BotHostUiProtocol.OP_PAUSE, null).exceptionally(error -> null);
    }

    /** 显式重建连接：不重发旧请求、不重放观察或变更。 */
    public CompletableFuture<JSONObject> reconnect() {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        CompletableFuture<JSONObject> superseded;
        ServiceConnection bind;
        int session;
        synchronized (lock) {
            if (state == State.CLOSED) {
                result.completeExceptionally(new BridgeException("CLOSED", "not-sent", "连接已关闭"));
                return result;
            }
            attempt++;
            teardownLocked();
            failAllLocked("CANCELLED", "连接已重建");
            events.clear();
            eventBytes = 0;
            latched = null;
            superseded = connecting;
            connecting = result;
            bind = prepareBindLocked();
            session = attempt;
        }
        if (superseded != null) {
            // 被取代的 reconnect 只结算一次，旧完成不得重置更新的失败/连接。
            superseded.completeExceptionally(new BridgeException("CANCELLED", "not-sent", "连接已重建"));
        }
        connect(bind, session);
        return result;
    }

    /** 永久关闭本客户端：解绑并失败未完成请求；不触碰 Host。 */
    public void close() {
        CompletableFuture<JSONObject> connected;
        synchronized (lock) {
            if (state == State.CLOSED) return;
            state = State.CLOSED;
            attempt++;
            teardownLocked();
            failAllLocked("CLOSED", "连接已关闭");
            events.clear();
            eventBytes = 0;
            connected = connecting;
            connecting = null;
            lock.notifyAll();
        }
        clock.shutdownNow();
        handshake.shutdownNow();
        if (connected != null) {
            connected.completeExceptionally(new BridgeException("CLOSED", "not-sent", "连接已关闭"));
        }
    }

    // ---------- 绑定与开话（阻塞 Binder/socket 调用一律在 state lock 之外） ----------

    private ServiceConnection prepareBindLocked() {
        state = State.BINDING;
        final int session = ++attempt;
        ServiceConnection conn = new ServiceConnection() {
            @Override public void onServiceConnected(ComponentName name, IBinder service) {
                try {
                    // 握手 transact 不在主线程做，也不排无界队列。
                    handshake.execute(() -> openSession(session, service));
                } catch (RejectedExecutionException busy) {
                    synchronized (lock) {
                        failLocked(session, new BridgeException("NOT_CONNECTED", "not-sent", "Host 通道不可用"));
                    }
                }
            }

            @Override public void onServiceDisconnected(ComponentName name) {
                onTransportLost(session, "Host 通道已断开");
            }

            @Override public void onBindingDied(ComponentName name) {
                onTransportLost(session, "Host 通道已失效");
            }

            @Override public void onNullBinding(ComponentName name) {
                onTransportLost(session, "Host 通道不可用");
            }
        };
        connection = conn;
        watchdog = () -> onTransportLost(session, "Host 通道连接超时");
        main.postDelayed(watchdog, CONNECT_TIMEOUT_MS);
        return conn;
    }

    private void connect(ServiceConnection conn, int session) {
        boolean bound;
        try {
            bound = context.bindService(new Intent(context, BotHostUiBridgeService.class), conn,
                    Context.BIND_AUTO_CREATE);
        } catch (RuntimeException unsupported) {
            bound = false;
        }
        if (bound) return;
        synchronized (lock) {
            if (session == attempt && connection == conn) connection = null;
            failLocked(session, new BridgeException("NOT_CONNECTED", "not-sent", "无法连接 Host 通道"));
        }
    }

    private void openSession(int session, IBinder service) {
        String token = BotHostUiProtocol.newToken();
        Parcel data = Parcel.obtain();
        Parcel reply = Parcel.obtain();
        ParcelFileDescriptor endpoint = null;
        String echoed = null;
        BridgeException problem = null;
        try {
            data.writeInterfaceToken(BotHostUiProtocol.DESCRIPTOR);
            data.writeString(token);
            if (!service.transact(BotHostUiProtocol.TRANSACTION_OPEN_SESSION, data, reply, 0)) {
                problem = new BridgeException("NOT_CONNECTED", "not-sent", "Host 通道不可用");
            } else {
                reply.readException();
                echoed = reply.readString();
                endpoint = ParcelFileDescriptor.CREATOR.createFromParcel(reply);
            }
        } catch (RemoteException | RuntimeException rejected) {
            problem = new BridgeException("NOT_CONNECTED", "not-sent", "Host 通道不可用");
        } finally {
            reply.recycle();
            data.recycle();
        }
        InputStream input = null;
        synchronized (lock) {
            if (session != attempt || state != State.BINDING) {
                closeQuietly(endpoint); // 旧连接/已关闭：丢弃晚到端点
                return;
            }
            if (endpoint == null || problem != null || !token.equals(echoed)) {
                closeQuietly(endpoint);
                failLocked(session, problem != null ? problem
                        : new BridgeException("NOT_CONNECTED", "not-sent", "Host 通道不可用"));
                return;
            }
            try {
                input = new FileInputStream(endpoint.getFileDescriptor());
                out = new FileOutputStream(endpoint.getFileDescriptor());
            } catch (RuntimeException inUse) {
                closeQuietly(endpoint);
                failLocked(session, new BridgeException("NOT_CONNECTED", "not-sent", "Host 通道不可用"));
                return;
            }
            channel = endpoint;
            binder = service;
            IBinder.DeathRecipient recipient = () -> onBinderDied(session);
            try {
                service.linkToDeath(recipient, 0);
                death = recipient;
            } catch (RemoteException gone) {
                failLocked(session, new BridgeException("CLOSED", "not-sent", "Host 通道已失效"));
                return;
            }
            if (watchdog != null) {
                main.removeCallbacks(watchdog);
                watchdog = null;
            }
            state = State.OPEN;
            // 成功握手：与 OPEN 状态切换同一临界区结算本次 reconnect（初始懒绑定本无 connecting）。
            // 先取出并置空再完成，仍持锁，supersede/close 无法在两步之间挤入。
            CompletableFuture<JSONObject> connected = connecting;
            connecting = null;
            if (connected != null) connected.complete(BotHostUiProtocol.object("connected", true));
            lock.notifyAll();
        }
        // javac：input 在锁内被赋值/复赋值，非 effectively final；捕获前固定到 final 局部量
        // （此路径下 input 必已建立，其余分支已提前 return）。
        final InputStream readerStream = input;
        Thread reader = new Thread(() -> readLoop(session, readerStream), "bot-host-ui-bridge-reader");
        reader.setDaemon(true);
        reader.start();
    }

    // ---------- 写出（唯一 writer 线程，不持锁做 socket IO） ----------

    private void writeLoop() {
        while (true) {
            Job job;
            OutputStream stream;
            int session;
            synchronized (lock) {
                while (true) {
                    if (state == State.CLOSED) return;
                    if (state == State.OPEN && out != null && !outbox.isEmpty()) break;
                    try {
                        lock.wait();
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
                job = outbox.poll();
                if (job == null) continue;
                // 过期/取消/失败后不得写出；写出开始、transcript 与期限取消共用 state lock。
                if (!ownedLocked(job) || job.wrote) continue;
                if (SystemClock.elapsedRealtime() >= job.deadline) {
                    // 排队期间已过期（计时器可能晚到）：结算 not-sent，绝不迟到写出。
                    if (releaseJobLocked(job)) {
                        job.future.completeExceptionally(new BridgeException("TIMEOUT", "not-sent", "请求超时"));
                    }
                    continue;
                }
                job.wrote = true;
                job.session = attempt;
                // 与 job 准入同一临界区捕获：旧 job 绝不能写到新会话的流上。
                stream = out;
                session = attempt;
            }
            try {
                stream.write(job.line);
                stream.write('\n');
                stream.flush();
            } catch (IOException | RuntimeException broken) {
                synchronized (lock) {
                    // 只失败捕获到的会话，不影响后来 reconnect 的新会话。
                    failLocked(session, new BridgeException("CLOSED", "unconfirmed", "Host 通道写入失败"));
                }
            } finally {
                synchronized (lock) {
                    releaseBytesLocked(job); // 写完/写失败都只归还一次写缓冲配额
                }
            }
        }
    }

    // ---------- 接收 ----------

    private void readLoop(int session, InputStream stream) {
        BotHostUiProtocol.LineReader lines = new BotHostUiProtocol.LineReader(BotHostUiProtocol.MAX_LINE_BYTES);
        try {
            while (true) {
                String line = lines.readLine(stream);
                if (line == null) break;
                if (line.trim().isEmpty()) continue;
                JSONObject frame;
                try {
                    frame = BotHostUiProtocol.parse(line);
                } catch (IOException invalid) {
                    protocolFailure(session);
                    return;
                }
                if (!handleFrame(session, frame)) return;
            }
            onTransportLost(session, "Host 通道已关闭");
        } catch (IOException broken) {
            onTransportLost(session, "Host 通道读取失败");
        } catch (RuntimeException broken) {
            onTransportLost(session, "Host 通道读取失败");
        }
    }

    private boolean handleFrame(int session, JSONObject frame) {
        String type = frame.optString("type");
        if (BotHostUiProtocol.TYPE_EVENT.equals(type)) {
            String event = frame.optString("event");
            JSONObject data = frame.optJSONObject("data");
            if (event.isEmpty() || data == null) return protocolFailure(session);
            return admitEvent(session, event, data);
        }
        if (BotHostUiProtocol.TYPE_RESPONSE.equals(type)) return handleResponse(session, frame);
        return protocolFailure(session);
    }

    /** 响应边界严格：ok 必须是布尔、result/error 必须是对象；畸形帧按 unconfirmed 协议失败，不伪造成功。 */
    private boolean handleResponse(int session, JSONObject frame) {
        String id = frame.optString("id");
        Job job;
        JSONObject result = null;
        BridgeException failure = null;
        boolean malformed = false;
        synchronized (lock) {
            if (session != attempt) return false;
            job = reservedPause != null && reservedPause.id.equals(id) ? reservedPause : pending.get(id);
            if (job == null) return true; // 迟到/重复响应按后到忽略
            releaseJobLocked(job);
            Object okValue = frame.opt("ok");
            if (!(okValue instanceof Boolean)) {
                malformed = true;
            } else if ((Boolean) okValue) {
                result = frame.optJSONObject("result");
                malformed = result == null;
            } else {
                JSONObject error = frame.optJSONObject("error");
                malformed = error == null;
                if (!malformed) failure = BotHostUiProtocol.bridgeError(error);
            }
        }
        if (malformed) {
            // 已写出的请求无法判定结果：保留 unconfirmed，并让该会话按协议失败收尾。
            job.future.completeExceptionally(new BridgeException("PROTOCOL", "unconfirmed", "Host 通道帧无效"));
            synchronized (lock) {
                failLocked(session, new BridgeException("PROTOCOL", "invalid", "Host 通道帧无效"));
            }
            return false;
        }
        if (failure != null) job.future.completeExceptionally(failure);
        else job.future.complete(result);
        return true;
    }

    /** reader 线程先做有界准入，再交给主线程交付；溢出即判本会话事件流失效。 */
    private boolean admitEvent(int session, String event, JSONObject data) {
        int bytes;
        try {
            bytes = data.toString().getBytes(StandardCharsets.UTF_8).length + event.length();
        } catch (RuntimeException invalid) {
            return protocolFailure(session);
        }
        synchronized (lock) {
            if (session != attempt) return true; // 旧代帧：丢弃
            if (state != State.OPEN && state != State.BINDING) return true;
            if (events.size() >= BotHostUiProtocol.MAX_OUTPUT_FRAMES
                    || eventBytes + bytes > BotHostUiProtocol.MAX_OUTPUT_BYTES) {
                failLocked(session, new BridgeException("BUSY", "unconfirmed", "UI 事件通道拥塞"));
                return false;
            }
            events.add(new Delivery(session, event, data, bytes));
            eventBytes += bytes;
            if (!draining) {
                draining = true;
                main.post(drain);
            }
            return true;
        }
    }

    /** 唯一 drain：交付期间该项仍计入 8 帧/80MiB，交付返回后才移除并归还配额。 */
    private void drainEvents() {
        while (true) {
            Delivery delivery;
            synchronized (lock) {
                if (events.isEmpty()) {
                    draining = false;
                    return;
                }
                delivery = events.get(0);
                if (delivery.attempt != attempt || state != State.OPEN) {
                    if (events.remove(delivery)) eventBytes -= delivery.bytes;
                    continue;
                }
            }
            try {
                Listener target = listener;
                if (target != null) target.onEvent(delivery.event, delivery.data);
            } catch (RuntimeException ignored) {
                // 订阅方异常不得卡死 drain 队列。
            } finally {
                synchronized (lock) {
                    if (events.remove(delivery)) eventBytes -= delivery.bytes;
                }
            }
        }
    }

    private boolean protocolFailure(int session) {
        synchronized (lock) {
            failLocked(session, new BridgeException("PROTOCOL", "invalid", "Host 通道帧无效"));
        }
        return false;
    }

    private void onTransportLost(int session, String message) {
        synchronized (lock) {
            failLocked(session, new BridgeException("CLOSED", "unconfirmed", message));
        }
    }

    private void onBinderDied(int session) {
        synchronized (lock) {
            failLocked(session, new BridgeException("CLOSED", "unconfirmed", "Host 通道已失效"));
        }
    }

    // ---------- 期限、失败与清理（全部持 lock） ----------

    private void expire(Job job) {
        BridgeException timeout = null;
        int session = 0;
        boolean blockedWrite = false;
        synchronized (lock) {
            if (releaseJobLocked(job)) {
                timeout = new BridgeException("TIMEOUT", job.wrote ? "unconfirmed" : "not-sent", "请求超时");
                if (job.wrote) {
                    // 已开始写出却被卡住：关闭它捕获的 transport 解除 IO，保留 unconfirmed。
                    session = job.session;
                    blockedWrite = true;
                }
            }
        }
        if (timeout == null) return;
        job.future.completeExceptionally(timeout);
        if (blockedWrite) {
            synchronized (lock) {
                failLocked(session, new BridgeException("TIMEOUT", "unconfirmed", "请求超时"));
            }
        }
    }

    private boolean ownedLocked(Job job) {
        return job.reserved ? reservedPause == job : pending.get(job.id) == job;
    }

    /** 只摘除登记/计时/待写与字节配额，不完成 future（供响应路径自行交付）。 */
    private boolean releaseJobLocked(Job job) {
        if (!ownedLocked(job)) return false;
        if (job.reserved) {
            reservedPause = null;
        } else {
            pending.remove(job.id);
            if (job.clientCleanup) clientCleanupInFlight--;
        }
        outbox.remove(job);
        releaseBytesLocked(job);
        if (job.timer != null) {
            job.timer.cancel(false);
            job.timer = null;
        }
        return true;
    }

    /** 排队/在写字节配额只归还一次。 */
    private void releaseBytesLocked(Job job) {
        if (!job.bytesHeld) return;
        job.bytesHeld = false;
        queuedBytes -= job.bytes;
    }

    /** 按各条目实际是否已开始写出分类 not-sent/unconfirmed，绝不用一条统一 outcome 覆盖。 */
    private void failAllLocked(String code, String message) {
        List<Job> jobs = new ArrayList<>(pending.values());
        pending.clear();
        if (reservedPause != null) {
            jobs.add(reservedPause);
            reservedPause = null;
        }
        outbox.clear();
        for (Job job : jobs) {
            releaseBytesLocked(job);
            if (job.clientCleanup) clientCleanupInFlight--;
            if (job.timer != null) {
                job.timer.cancel(false);
                job.timer = null;
            }
            job.future.completeExceptionally(
                    new BridgeException(code, job.wrote ? "unconfirmed" : "not-sent", message));
        }
    }

    private void failLocked(int session, BridgeException sessionFailure) {
        if (session != attempt || state == State.CLOSED) return;
        attempt++;
        state = State.FAILED;
        latched = sessionFailure;
        teardownLocked();
        failAllLocked(sessionFailure.code != null ? sessionFailure.code : "CLOSED", sessionFailure.getMessage());
        events.clear();
        eventBytes = 0;
        CompletableFuture<JSONObject> connected = connecting;
        connecting = null;
        if (connected != null) connected.completeExceptionally(latchedNotSent());
        failures++;
        notifyClosed(sessionFailure, failures);
    }

    /** 失败后新普通请求只按 not-sent 拒绝，不复制旧失败条目的 outcome。 */
    private BridgeException latchedNotSent() {
        String code = latched != null && latched.code != null ? latched.code : "CLOSED";
        return new BridgeException(code, "not-sent", "Host 通道不可用");
    }

    private void notifyClosed(BridgeException error, int generation) {
        if (listener == null) return;
        main.post(() -> {
            synchronized (lock) {
                // 代数围栏：后续 reconnect/close 或再次失败后不得再交付旧失败。
                if (generation != failures || state != State.FAILED) return;
            }
            try {
                listener.onClosed(error);
            } catch (RuntimeException ignored) {
                // 订阅方异常不影响客户端状态。
            }
        });
    }

    private void teardownLocked() {
        if (watchdog != null) {
            main.removeCallbacks(watchdog);
            watchdog = null;
        }
        IBinder target = binder;
        IBinder.DeathRecipient recipient = death;
        binder = null;
        death = null;
        if (target != null && recipient != null) {
            try {
                target.unlinkToDeath(recipient, 0);
            } catch (RuntimeException ignored) {
            }
        }
        ServiceConnection conn = connection;
        connection = null;
        if (conn != null) {
            // 解绑是 AMS binder 调用：交给主线程异步执行，不在 state lock 内做 binder 事务。
            main.post(() -> {
                try {
                    context.unbindService(conn);
                } catch (RuntimeException ignored) {
                }
            });
        }
        out = null;
        ParcelFileDescriptor current = channel;
        channel = null;
        shutdownAndClose(current);
        lock.notifyAll(); // 唤醒 writer 重新等待连接
    }

    /** 先 SHUT_RDWR 解除阻塞中的读写，再关闭端点。 */
    private static void shutdownAndClose(ParcelFileDescriptor descriptor) {
        if (descriptor == null) return;
        try {
            Os.shutdown(descriptor.getFileDescriptor(), OsConstants.SHUT_RDWR);
        } catch (ErrnoException ignored) {
        } catch (RuntimeException ignored) {
        }
        closeQuietly(descriptor);
    }

    private static CompletableFuture<JSONObject> failed(Throwable failure) {
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        future.completeExceptionally(failure);
        return future;
    }

    private static void closeQuietly(Closeable target) {
        if (target == null) return;
        try {
            target.close();
        } catch (Throwable ignored) {
        }
    }
}
