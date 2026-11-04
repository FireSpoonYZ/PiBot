package com.example.launcherprobe;

import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Binder;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Parcel;
import android.os.Parcelable;
import android.os.ParcelFileDescriptor;
import android.os.Process;
import android.os.RemoteException;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/**
 * M18 私有 UI↔Host 桥服务：默认进程内 non-exported Binder，只把固定 Host 数据操作转给 BotHostManager。
 * 桥不因绑定启动 Host、不重放请求；saveCredentials 仅按旧插件语义把别名交给
 * BotHostManager 受控转发（本层无 getter、不落盘、不打印）。
 * 每个 UI 进程一个 socket 会话：EOF/关闭只释放本会话登记过的观察与语音捕获。
 * client* 固定入口使用应用级独立客户端 broker；客户端退出时关闭所有 UI 会话。
 */
public final class BotHostUiBridgeService extends Service {
    private static final int MAX_OBSERVATIONS = 8;
    /** broker 强制 UUID 形式的 observationId（其事件也带同一 id），本层同样只接受该形式。 */
    private static final Pattern OBSERVATION_ID = Pattern.compile(
            "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");

    private static volatile BotHostUiBridgeService activeService;
    private final List<Session> sessions = new ArrayList<>();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Binder binder = new SessionBinder();
    private boolean destroyed;

    @Override public void onCreate() {
        super.onCreate();
        activeService = this;
    }

    @Override public IBinder onBind(Intent intent) { return binder; }

    static void closeClientSessions() {
        BotHostUiBridgeService service = activeService;
        if (service == null) return;
        List<Session> copy;
        synchronized (service.sessions) { copy = new ArrayList<>(service.sessions); }
        for (Session session : copy) {
            session.close(new BridgeException("CANCELLED", "responded", "客户端已退出"));
        }
    }

    @Override public void onDestroy() {
        if (activeService == this) activeService = null;
        List<Session> copy;
        synchronized (sessions) {
            destroyed = true;
            copy = new ArrayList<>(sessions);
            sessions.clear();
        }
        for (Session session : copy) {
            session.close(new BridgeException("CANCELLED", "responded", "UI 桥已关闭"));
        }
        super.onDestroy();
    }

    /** 唯一 Binder 事务：同 UID + token 才换 socket 端点；Binder 内不传业务 JSON。 */
    private final class SessionBinder extends Binder {
        @Override protected boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
            if (code != BotHostUiProtocol.TRANSACTION_OPEN_SESSION) {
                return super.onTransact(code, data, reply, flags);
            }
            data.enforceInterface(BotHostUiProtocol.DESCRIPTOR);
            String token = data.readString();
            if (Binder.getCallingUid() != Process.myUid()
                    || token == null || !BotHostUiProtocol.TOKEN.matcher(token).matches()) {
                reply.writeException(new SecurityException("调用方不受信任"));
                return true;
            }
            BooleanSupplier clientLifecycle = BotClientService.ownerOpen();
            if (!clientLifecycle.getAsBoolean()) {
                reply.writeException(new IllegalStateException("客户端未运行"));
                return true;
            }
            Session session;
            try {
                session = new Session(clientLifecycle);
            } catch (IOException failure) {
                reply.writeException(new IllegalStateException("无法建立私有通道"));
                return true;
            }
            synchronized (sessions) {
                if (destroyed || !clientLifecycle.getAsBoolean()) {
                    session.close(new BridgeException("CANCELLED", "responded", "UI 桥或客户端已关闭"));
                    reply.writeException(new IllegalStateException("UI 桥已关闭"));
                    return true;
                }
                sessions.add(session); // 先登记：onDestroy/close 才能找到并回收它
            }
            try {
                session.start();
            } catch (IOException failure) {
                session.close(new BridgeException("CANCELLED", "responded", "UI 通道建立失败"));
                reply.writeException(new IllegalStateException("无法建立私有通道"));
                return true;
            }
            reply.writeNoException();
            reply.writeString(token);
            try {
                session.transferTo(reply);
            } catch (RuntimeException failure) {
                session.close(new BridgeException("CANCELLED", "responded", "UI 通道建立失败"));
                throw failure;
            }
            return true;
        }
    }

    private final class Session {
        private final ParcelFileDescriptor server;
        /** 交给 UI 的端点；transferTo 后本进程不再持有，否则 peer close 永远等不到 EOF。 */
        private ParcelFileDescriptor channel;
        private final Object fdLock = new Object();
        /** 本会话全部观察/捕获登记与释放的唯一串行锁。 */
        private final Object resources = new Object();
        private final ArrayBlockingQueue<byte[]> output =
                new ArrayBlockingQueue<>(BotHostUiProtocol.MAX_OUTPUT_FRAMES);
        private final AtomicLong outputBytes = new AtomicLong();
        private final AtomicInteger outputFrames = new AtomicInteger();
        private final AtomicInteger inFlight = new AtomicInteger();
        private final Map<String, Observation> observations = new HashMap<>();
        private final AtomicBoolean closed = new AtomicBoolean();
        private final BooleanSupplier clientLifecycle;
        /** 本 UI 会话在客户端子进程上的身份：单写者校验用，关闭/EOF 后不可再被复用。 */
        private final String clientOwner = UUID.randomUUID().toString();
        private final BotHostUiProtocol.LineReader lines =
                new BotHostUiProtocol.LineReader(BotHostUiProtocol.MAX_LINE_BYTES);
        private volatile OutputStream out;
        private BotHostVoice voice;
        private String voiceBotId;
        private String voiceRequestId;

        Session(BooleanSupplier clientLifecycle) throws IOException {
            this.clientLifecycle = clientLifecycle;
            ParcelFileDescriptor[] pair = ParcelFileDescriptor.createSocketPair();
            server = pair[0];
            channel = pair[1];
        }

        void start() throws IOException {
            InputStream input = new FileInputStream(server.getFileDescriptor());
            out = new FileOutputStream(server.getFileDescriptor());
            Thread writer = new Thread(this::writeLoop, "bot-host-ui-bridge-writer");
            writer.setDaemon(true);
            writer.start();
            Thread reader = new Thread(() -> readLoop(input), "bot-host-ui-bridge-reader");
            reader.setDaemon(true);
            reader.start();
        }

        /** 移交端点：PARCELABLE_WRITE_RETURN_VALUE 让 parcel 接管 fd 并关闭本进程副本。 */
        void transferTo(Parcel reply) {
            ParcelFileDescriptor endpoint;
            synchronized (fdLock) {
                endpoint = channel;
                channel = null;
            }
            if (endpoint == null) throw new IllegalStateException("UI 端点已移交");
            try {
                endpoint.writeToParcel(reply, Parcelable.PARCELABLE_WRITE_RETURN_VALUE);
            } catch (RuntimeException failure) {
                closeQuietly(endpoint);
                throw failure;
            }
        }

        // ---------- 传输 ----------

        private void readLoop(InputStream input) {
            try {
                while (!closed.get()) {
                    String line = lines.readLine(input);
                    if (line == null) break;
                    if (line.trim().isEmpty()) continue;
                    JSONObject frame;
                    try {
                        frame = BotHostUiProtocol.parse(line);
                    } catch (IOException invalid) {
                        throw new BridgeException("PROTOCOL", "invalid", "请求帧无效");
                    }
                    onFrame(frame);
                }
                close(new BridgeException("CLOSED", "closed", "UI 通道已关闭"));
            } catch (IOException failure) {
                close(failure instanceof BridgeException ? (BridgeException) failure
                        : new BridgeException("CLOSED", "unconfirmed", "UI 通道读取失败"));
            }
        }

        private void writeLoop() {
            try {
                while (true) {
                    byte[] line = output.poll(200, TimeUnit.MILLISECONDS);
                    if (line == null) {
                        if (closed.get()) break;
                        continue;
                    }
                    OutputStream stream = out;
                    if (stream == null) break;
                    stream.write(line);
                    stream.write('\n');
                    stream.flush();
                    // 写完后才归还配额：预算必须含 writer 持有的这一帧。
                    outputBytes.addAndGet(-line.length);
                    outputFrames.decrementAndGet();
                }
            } catch (IOException failure) {
                close(failure instanceof BridgeException ? (BridgeException) failure
                        : new BridgeException("CLOSED", "unconfirmed", "UI 通道写入失败"));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                close(new BridgeException("CLOSED", "unconfirmed", "UI 通道写入被中断"));
            }
        }

        /** 有界输出：帧数（含 writer 持有一帧）与字节双预算，满载即关闭本会话，不建无界写队列。 */
        private void send(JSONObject frame) {
            if (closed.get()) return;
            byte[] bytes;
            try {
                bytes = BotHostUiProtocol.line(frame);
            } catch (IOException oversize) {
                close(new BridgeException("TOO_LARGE", "unconfirmed", "UI 事件帧超限"));
                return;
            }
            long size = bytes.length;
            if (outputFrames.incrementAndGet() > BotHostUiProtocol.MAX_OUTPUT_FRAMES) {
                outputFrames.decrementAndGet();
                close(new BridgeException("BUSY", "unconfirmed", "UI 事件通道拥塞"));
                return;
            }
            if (outputBytes.addAndGet(size) > BotHostUiProtocol.MAX_OUTPUT_BYTES) {
                outputBytes.addAndGet(-size);
                outputFrames.decrementAndGet();
                close(new BridgeException("BUSY", "unconfirmed", "UI 事件通道拥塞"));
                return;
            }
            if (!output.offer(bytes)) {
                outputBytes.addAndGet(-size);
                outputFrames.decrementAndGet();
                close(new BridgeException("BUSY", "unconfirmed", "UI 事件通道拥塞"));
            }
        }

        /** 只释放本会话登记过的观察/捕获，绝不 manager.stop/abort。 */
        void close(BridgeException failure) {
            if (!closed.compareAndSet(false, true)) return;
            synchronized (sessions) {
                sessions.remove(this);
            }
            output.clear();
            outputBytes.set(0);
            outputFrames.set(0);
            releaseOwnedResources(failure, false);
            BotClientService.clearVisibility(clientOwner);

            out = null;
            ParcelFileDescriptor endpoint;
            synchronized (fdLock) {
                endpoint = channel;
                channel = null;
            }
            // SHUT_RDWR 先解除阻塞中的读写，再关闭两端的本进程副本。
            shutdownAndClose(endpoint);
            shutdownAndClose(server);
        }

        private boolean clientSessionOpen() { return !closed.get() && clientLifecycle.getAsBoolean(); }

        // ---------- 请求派发（reader 线程顺序执行，非阻塞 manager 操作） ----------

        private void onFrame(JSONObject frame) throws IOException {
            if (!BotHostUiProtocol.TYPE_REQUEST.equals(frame.optString("type"))) {
                throw new BridgeException("PROTOCOL", "invalid", "未预期帧");
            }
            String id = frame.optString("id");
            if (id.isEmpty()) throw new BridgeException("PROTOCOL", "invalid", "请求缺 id");
            String op = frame.optString("op");
            JSONObject params = frame.optJSONObject("params");
            if (!BotHostUiProtocol.isOperation(op)) {
                send(BotHostUiProtocol.responseError(id,
                        new BridgeException("INVALID_ARGUMENT", "not-sent", "不支持的操作")));
                return;
            }
            // pause 与 clientUnobserve 为保留清理槽：不受 8 个普通 in-flight 限制，普通请求满载时
            // 仍能生效；数量额度由 BotHostUiBridgeClient 的独立清理槽（pause 单合并槽 + 客户端
            // 观察清理 ≤2）约束，不在本层无界堆积。
            boolean reserved = BotHostUiProtocol.isCleanupOperation(op);
            if (!reserved && inFlight.incrementAndGet() > BotHostUiProtocol.MAX_IN_FLIGHT) {
                inFlight.decrementAndGet();
                send(BotHostUiProtocol.responseError(id,
                        new BridgeException("BUSY", "not-sent", "请求并发已满")));
                return;
            }
            run(id, op, params, reserved);
        }

        /** 顺序派发保证此前入队的 observe/startVoice 一定早于随后 pause/close 的资源释放。 */
        private void run(String id, String op, JSONObject params, boolean reserved) {
            CompletableFuture<JSONObject> result;
            try {
                result = dispatch(op, params);
            } catch (Throwable failure) {
                result = failed(failure);
            }
            result.whenComplete((payload, failure) -> {
                try {
                    send(failure == null
                            ? BotHostUiProtocol.response(id, payload)
                            : BotHostUiProtocol.responseError(id, failure));
                } finally {
                    if (!reserved) inFlight.decrementAndGet();
                }
            });
        }

        private CompletableFuture<JSONObject> dispatch(String op, JSONObject params) throws IOException {
            ensureOpen();
            BotHostManager manager = BotHostManager.get(BotHostUiBridgeService.this);
            switch (op) {
                case "snapshot":
                    return done(manager.snapshot());
                case "status":
                    return manager.status();
                case "centerSettings":
                    return done(manager.centerSettings());
                case "saveCenterSettings":
                    return BotClientService.saveHostCenterSettings(BotHostUiBridgeService.this, requiredObject(params, "input"));
                case "settingsGet":
                    return manager.settingsGet(this::clientSessionOpen);
                case "settingsSet":
                    return manager.settingsSet(requiredObject(params, "input"), this::clientSessionOpen);
                case "saveCredentials":
                    return manager.saveCredentials(optionalObject(params, "aliases"))
                            .thenApply(ignored -> new JSONObject());
                case "call":
                    String method = required(params, "method");
                    JSONObject callParams = optionalObject(params, "params");
                    if ("submit".equals(method) && callParams != null) {
                        String localDeviceId = manager.snapshot().optString("deviceId", "");
                        String localBotId = callParams.optString("botId");
                        String localRequestId = callParams.optString("requestId");
                        return manager.call(method, callParams).whenComplete((value, failure) ->
                                BotClientService.trackLocalResult(BotHostUiBridgeService.this, localDeviceId,
                                        localBotId, localRequestId, failure));
                    }
                    return manager.call(method, callParams);
                case "observe":
                    return observe(manager, params);
                case "cancelObservation":
                    return cancelObservation(params);
                case "voiceSettings":
                    return done(manager.voice().getSettings());
                case "saveVoiceSettings":
                    manager.voice().saveSettings(requiredObject(params, "settings"));
                    return done(new JSONObject());
                case "startVoice":
                    return startVoice(manager, params);
                case "finishVoice":
                    return finishVoice(params);
                case "cancelVoice":
                    return cancelVoice(params);
                case "uiSettings":
                    return done(uiSettings());
                case "clientConnectionProbe":
                    client().checkConnection(true);
                    return done(new JSONObject());
                case "clientChatVisibility":
                    String deviceId = required(params, "deviceId");
                    String botId = required(params, "botId");
                    Object visible = params.opt("visible");
                    if (!(visible instanceof Boolean)) throw new IllegalArgumentException("visible is required");
                    BotClientService.setVisibility(clientOwner, deviceId, botId, (Boolean) visible);
                    return done(new JSONObject());
                case "clientRequest":
                    return clientRequest(params);
                case "clientObserve":
                    return clientObserve(params);
                case "clientUnobserve":
                    return cancelObservation(params).thenApply(ignored -> new JSONObject());
                case BotHostUiProtocol.OP_PAUSE:
                    return pause();
                default:
                    return failed(new BridgeException("INVALID_ARGUMENT", "not-sent", "不支持的操作"));
            }
        }

        private CompletableFuture<JSONObject> done(JSONObject value) {
            return CompletableFuture.completedFuture(value == null ? new JSONObject() : value);
        }

        // ---------- 客户端（M20 远端 Host）：首次 clientRequest 才懒启动、单写者 ----------

        /** 固定 broker 操作透传；返回 {value:<broker 结果>}，原 code/outcome 不改写。 */
        private CompletableFuture<JSONObject> clientRequest(JSONObject params) throws IOException {
            ensureOpen();
            String op = required(params, "op");
            JSONObject input = params.has("params") && !params.isNull("params")
                    ? requiredObject(params, "params")
                    : new JSONObject();
            CompletableFuture<JSONObject> result = client().request(clientOwner, () -> !closed.get() && BotClientService.isActive(), op, input);
            if ("pending_send".equals(op)) result.whenComplete((value, failure) -> {
                if (failure == null || "unconfirmed".equals(BotHostUiProtocol.errorOutcome(failure)))
                    BotClientService.requestPoll();
            });
            return result;
        }

        /** 先登记再派发：broker 首个 snapshot 早于客户端句柄也能路由回本会话。 */
        private CompletableFuture<JSONObject> clientObserve(JSONObject params) throws IOException {
            String observationId = required(params, "observationId");
            String targetDeviceId = required(params, "targetDeviceId");
            JSONObject target = requiredObject(params, "target");
            // broker 以 UUID 作为观察 id，且事件带着它回来：要求同上，避免两套 id。
            if (!OBSERVATION_ID.matcher(observationId).matches()) {
                throw new BridgeException("INVALID_ARGUMENT", "not-sent", "observationId 须为 UUID");
            }
            boolean connection = "connection".equals(target.optString("kind"));
            Observation record = new Observation(observationId, true);
            record.connection = connection;
            synchronized (resources) {
                ensureOpen();
                int business = 0;
                boolean watch = false;
                for (Observation item : observations.values()) {
                    if (item.connection) {
                        if (connection && !item.id.equals(observationId)) item.closed = true;
                        else watch = true;
                    }
                    else business++;
                }
                if (connection) observations.values().removeIf(item -> item.connection && item.closed);
                if (connection ? watch : business >= MAX_OBSERVATIONS) throw new IllegalStateException("观察数已达上限");
                if (observations.containsKey(observationId)) throw new IllegalArgumentException("observationId 已存在");
                observations.put(observationId, record);
            }
            return client().observe(clientOwner, () -> !closed.get() && BotClientService.isActive(),
                            () -> BotClientService.isActive() && observationActive(record),
                            observationId,
                            BotHostUiProtocol.object("targetDeviceId", targetDeviceId, "target", target),
                            event -> onClientFrame(record, event),
                            error -> onObservationError(record, error))
                    .whenComplete((value, failure) -> {
                        if (failure == null) return;
                        // 派发前失败：移除本会话登记，并只回该请求错误（不伪造事件）。
                        synchronized (resources) {
                            record.closed = true;
                            if (observations.get(observationId) == record) observations.remove(observationId);
                        }
                    });
        }

        /** 记录仍属本会话且未关闭：排队前/派发后复核，避免已撤销的观察被重新建立。 */
        private boolean observationActive(Observation record) {
            synchronized (resources) {
                return !record.closed && observations.get(record.id) == record;
            }
        }

        /** client 模式观察帧即 DesktopObservationEvent，原样作为 clientFrame 的 data。 */
        private void onClientFrame(Observation record, JSONObject event) {
            if (!"event".equals(event.optString("type"))) return;
            boolean terminal;
            synchronized (resources) {
                if (record.closed || observations.get(record.id) != record) return;
                JSONObject inner = event.optJSONObject("frame");
                terminal = event.has("error") || (inner != null && "end".equals(inner.optString("type")));
                if (terminal) {
                    record.closed = true;
                    observations.remove(record.id);
                }
            }
            send(BotHostUiProtocol.event(BotHostUiProtocol.EVENT_CLIENT_FRAME, event));
        }

        private void ensureOpen() throws IOException {
            if (closed.get() || !BotClientService.isActive())
                throw new BridgeException("CLOSED", "not-sent", "客户端或 UI 通道已关闭");
        }

        // ---------- 观察（本会话独占；断开/暂停只停自己） ----------

        /** 先登记再 observe，避免初始帧早于句柄；容量上限 8。client 记录无 manager 句柄，按 id 撤销。 */
        private final class Observation {
            final String id;
            final boolean client;
            boolean connection;
            volatile boolean closed;
            volatile BotHostManager.Observation handle;

            Observation(String id, boolean client) {
                this.id = id;
                this.client = client;
            }
        }

        private CompletableFuture<JSONObject> observe(BotHostManager manager, JSONObject params) throws IOException {
            String observationId = required(params, "observationId");
            JSONObject target = requiredObject(params, "target");
            String kind = target.optString("kind");
            if (!"primary".equals(kind) && !"work".equals(kind)) {
                throw new IllegalArgumentException("target.kind 无效");
            }
            if (target.optString("botId").isEmpty()) throw new IllegalArgumentException("target.botId 无效");
            if ("work".equals(kind) && target.optString("scopeId").isEmpty()) {
                throw new IllegalArgumentException("target.scopeId 无效");
            }
            Observation record = new Observation(observationId, false);
            synchronized (resources) {
                ensureOpen(); // 与 close/pause 的释放串行：清理后不再创建资源
                if (observations.size() >= MAX_OBSERVATIONS) throw new IllegalStateException("观察数已达上限");
                if (observations.containsKey(observationId)) throw new IllegalArgumentException("observationId 已存在");
                observations.put(observationId, record);
                // 登记与 manager.observe 入口同在 resources 临界区：close/pause 无法插到两者之间。
                try {
                    manager.observe(target, frame -> onObservationFrame(record, frame),
                                    error -> onObservationError(record, error))
                            .whenComplete((handle, failure) -> {
                                if (failure != null) {
                                    onObservationError(record, failure);
                                    return;
                                }
                                boolean closeNow;
                                synchronized (resources) {
                                    closeNow = record.closed;
                                    if (!closeNow) record.handle = handle;
                                }
                                if (closeNow) closeObservation(handle); // 迟到句柄立即关闭
                            });
                } catch (RuntimeException failure) {
                    observations.remove(observationId);
                    record.closed = true;
                    throw failure;
                }
            }
            return done(BotHostUiProtocol.object("observationId", observationId));
        }

        private CompletableFuture<JSONObject> cancelObservation(JSONObject params) {
            String observationId = required(params, "observationId");
            BotHostManager.Observation handle;
            boolean clientObservation;
            synchronized (resources) {
                Observation record = observations.remove(observationId);
                if (record == null) return done(new JSONObject());
                record.closed = true;
                clientObservation = record.client;
                handle = record.handle;
            }
            if (clientObservation) client().cancel(clientOwner, observationId);
            else closeObservation(handle);
            return done(new JSONObject());
        }

        private void onObservationFrame(Observation record, JSONObject frame) {
            boolean terminal;
            synchronized (resources) {
                if (record.closed || observations.get(record.id) != record) return;
                terminal = "end".equals(frame.optString("type"));
                if (terminal) {
                    record.closed = true;
                    observations.remove(record.id);
                }
            }
            send(BotHostUiProtocol.event(BotHostUiProtocol.EVENT_HOST_FRAME,
                    BotHostUiProtocol.object("observationId", record.id, "frame", frame)));
            if (terminal) closeObservation(record.handle);
        }

        private void onObservationError(Observation record, Throwable error) {
            BotHostManager.Observation handle;
            boolean clientObservation;
            synchronized (resources) {
                if (record.closed || observations.get(record.id) != record) return;
                record.closed = true;
                observations.remove(record.id);
                clientObservation = record.client;
                handle = record.handle;
            }
            if (clientObservation) {
                // 客户端观察错误同样按 DesktopObservationEvent 形状回传（带 error 成员）。
                send(BotHostUiProtocol.event(BotHostUiProtocol.EVENT_CLIENT_FRAME,
                        BotHostUiProtocol.clientErrorEvent(record.id, BotHostUiProtocol.errorObject(error))));
                return;
            }
            send(BotHostUiProtocol.event(BotHostUiProtocol.EVENT_HOST_FRAME,
                    BotHostUiProtocol.object("observationId", record.id,
                            "error", BotHostUiProtocol.errorObject(error))));
            closeObservation(handle);
        }

        /** pause 保留连接状态监听；close 释放全部观察。两者均结束捕获。 */
        private void releaseOwnedResources(BridgeException failure, boolean notify) {
            List<Observation> records;
            BotHostVoice capturing;
            String botId;
            String requestId;
            synchronized (resources) {
                records = new ArrayList<>();
                for (Observation record : observations.values()) {
                    // 页面暂停不等于中继断线，连接监听必须继续报告真实断线。
                    if (notify && record.connection) continue;
                    record.closed = true;
                    records.add(record);
                }
                for (Observation record : records) observations.remove(record.id);
                capturing = voice;
                botId = voiceBotId;
                requestId = voiceRequestId;
                voice = null;
                voiceBotId = null;
                voiceRequestId = null;
            }
            for (Observation record : records) {
                if (record.client) {
                    // 每个会话只释放自己的观察，客户端进程由应用共享。
                    if (notify) {
                        send(BotHostUiProtocol.event(BotHostUiProtocol.EVENT_CLIENT_FRAME,
                                BotHostUiProtocol.clientErrorEvent(record.id, BotHostUiProtocol.errorObject(failure))));
                    }
                    client().cancel(clientOwner, record.id);
                    continue;
                }
                if (notify) {
                    send(BotHostUiProtocol.event(BotHostUiProtocol.EVENT_HOST_FRAME,
                            BotHostUiProtocol.object("observationId", record.id,
                                    "error", BotHostUiProtocol.errorObject(failure))));
                }
                closeObservation(record.handle);
            }
            if (capturing != null && botId != null && requestId != null) {
                capturing.cancelInput(botId, requestId);
                if (notify) {
                    // 暂停才发终态：身份已在锁内取走，迟到回调无法再提交；只发错误、不伪造转录。
                    emitVoice("error", botId, requestId, null, null, "CANCELLED", "unconfirmed", "页面暂停，语音输入已结束");
                }
            }
        }

        // ---------- 语音（仅本会话捕获；原生提交一次） ----------

        private CompletableFuture<JSONObject> startVoice(BotHostManager manager, JSONObject params) throws IOException {
            String botId = required(params, "botId");
            String requestId = required(params, "requestId");
            BotHostVoice capturing = manager.voice();
            BotHostVoice.InputListener listener = new BotHostVoice.InputListener() {
                @Override public void onPartial(String text) {
                    main.post(() -> {
                        if (!ownsCapture(capturing, botId, requestId)) return;
                        emitVoice("partial", botId, requestId, text, null, null, null, null);
                    });
                }

                @Override public void onResult(String capturedBotId, String capturedRequestId, String text) {
                    main.post(() -> {
                        // 校验与清除同一临界区：并发 pause/新捕获不会误删新身份。
                        if (!takeCapture(capturing, capturedBotId, capturedRequestId)) return;
                        submitTranscript(capturedBotId, capturedRequestId, text);
                    });
                }

                @Override public void onError(String message) {
                    main.post(() -> {
                        if (!takeCapture(capturing, botId, requestId)) return;
                        emitVoice("error", botId, requestId, null, null, null, null, message);
                    });
                }
            };
            synchronized (resources) {
                ensureOpen();
                BotHostVoice previous = voice;
                String previousBotId = voiceBotId;
                String previousRequestId = voiceRequestId;
                voice = capturing;
                voiceBotId = botId;
                voiceRequestId = requestId;
                // 先按 FIFO 取消旧捕获，再在同一临界区内入队新捕获：
                // close/EOF 无法插到“登记完、startInput 未入队”之间而让新捕获在清理后启动。
                if (previous != null && previousBotId != null && previousRequestId != null) {
                    previous.cancelInput(previousBotId, previousRequestId);
                }
                // 前台/麦克风权限由 UI 侧插件校验；BotHostVoice 的权限失败会以 error 事件回传。
                capturing.startInput(botId, requestId, listener);
            }
            return done(new JSONObject());
        }

        private CompletableFuture<JSONObject> finishVoice(JSONObject params) {
            BotHostVoice capturing;
            String botId;
            String requestId;
            synchronized (resources) {
                String expectedBotId = BotHostUiProtocol.optionalString(params, "botId");
                String expectedRequestId = BotHostUiProtocol.optionalString(params, "requestId");
                if (expectedBotId != null && !expectedBotId.equals(voiceBotId)) return done(new JSONObject());
                if (expectedRequestId != null && !expectedRequestId.equals(voiceRequestId)) return done(new JSONObject());
                capturing = voice;
                botId = voiceBotId;
                requestId = voiceRequestId;
            }
            if (capturing != null && botId != null && requestId != null) capturing.finishInput(botId, requestId);
            return done(new JSONObject());
        }

        private CompletableFuture<JSONObject> cancelVoice(JSONObject params) {
            synchronized (resources) {
                String expectedBotId = BotHostUiProtocol.optionalString(params, "botId");
                String expectedRequestId = BotHostUiProtocol.optionalString(params, "requestId");
                if (expectedBotId != null && voiceBotId != null && !expectedBotId.equals(voiceBotId)) {
                    return done(new JSONObject());
                }
                if (expectedRequestId != null && voiceRequestId != null && !expectedRequestId.equals(voiceRequestId)) {
                    return done(new JSONObject());
                }
            }
            releaseCapture();
            return done(new JSONObject());
        }

        private CompletableFuture<JSONObject> pause() {
            BotClientService.clearVisibility(clientOwner);
            // 保留清理：只撤销本会话观察/捕获，不改已有请求结果、不关闭 Host。
            releaseOwnedResources(new BridgeException("CANCELLED", "responded", "页面暂停，观察已结束"), true);
            return done(new JSONObject());
        }

        private boolean ownsCapture(BotHostVoice candidate, String botId, String requestId) {
            synchronized (resources) {
                return !closed.get() && candidate == voice && voiceBotId != null && voiceRequestId != null
                        && voiceBotId.equals(botId) && voiceRequestId.equals(requestId);
            }
        }

        /** 原子校验并取走本会话捕获身份：只有仍属预期 owner 才能继续提交/报错。 */
        private boolean takeCapture(BotHostVoice candidate, String botId, String requestId) {
            synchronized (resources) {
                if (closed.get() || candidate != voice || voiceBotId == null || voiceRequestId == null
                        || !voiceBotId.equals(botId) || !voiceRequestId.equals(requestId)) {
                    return false;
                }
                voice = null;
                voiceBotId = null;
                voiceRequestId = null;
                return true;
            }
        }

        private void releaseCapture() {
            BotHostVoice capturing;
            String botId;
            String requestId;
            synchronized (resources) {
                capturing = voice;
                botId = voiceBotId;
                requestId = voiceRequestId;
                voice = null;
                voiceBotId = null;
                voiceRequestId = null;
            }
            if (capturing != null && botId != null && requestId != null) {
                capturing.cancelInput(botId, requestId);
            }
        }

        /** 唯一一次原生提交：Node submit schema 权威；失败只回事件，不自动重试。 */
        private void submitTranscript(String botId, String requestId, String text) {
            BotHostManager manager = BotHostManager.get(BotHostUiBridgeService.this);
            String deviceId = manager.snapshot().optString("deviceId", "");
            manager.call("submit", BotHostUiProtocol.object("botId", botId, "requestId", requestId, "text", text))
                    .whenComplete((envelope, failure) -> {
                        BotClientService.trackLocalResult(BotHostUiBridgeService.this, deviceId, botId, requestId, failure);
                        if (failure != null) {
                            emitVoice("error", botId, requestId, text, null,
                                    BotHostUiProtocol.errorCode(failure),
                                    BotHostUiProtocol.errorOutcome(failure),
                                    BotHostUiProtocol.safeMessage(failure));
                        } else {
                            emitVoice("submitted", botId, requestId, null,
                                    envelope != null && envelope.has("result") ? envelope.opt("result") : null,
                                    null, null, null);
                        }
                    });
        }

        private void emitVoice(String type, String botId, String requestId, String text, Object receipt,
                               String code, String outcome, String message) {
            send(BotHostUiProtocol.event(BotHostUiProtocol.EVENT_VOICE, BotHostUiProtocol.object(
                    "type", type,
                    "botId", botId,
                    "requestId", requestId,
                    "text", text,
                    "receipt", receipt,
                    "code", code,
                    "outcome", outcome,
                    "message", message)));
        }

    }

    // ---------- 共享工具 ----------

    /**
     * 默认进程内唯一的客户端管理器：Service 重建不重置上一代的 starting/closing 占有权，
     * 冷状态只取实例（不启动 Node、不准备资产）。
     */
    private BotHostClient client() {
        return BotHostClient.get(this);
    }

    /** 仅读取界面语言与主题，不读配置凭据。 */
    private JSONObject uiSettings() {
        SharedPreferences ui = getSharedPreferences("ui", MODE_PRIVATE);
        return BotHostUiProtocol.object(
                "language", ui.getString("language", "system"),
                "appearance", ui.getString("theme", "system"));
    }

    private static String required(JSONObject params, String name) {
        Object value = params == null ? null : params.opt(name);
        if (!(value instanceof String) || ((String) value).isEmpty()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return (String) value;
    }

    private static JSONObject requiredObject(JSONObject params, String name) {
        Object value = params == null ? null : params.opt(name);
        if (!(value instanceof JSONObject)) throw new IllegalArgumentException(name + " is required");
        return (JSONObject) value;
    }

    /** 旧插件 getObject 语义：缺省/非对象按省略处理，由 Manager 决定默认值。 */
    private static JSONObject optionalObject(JSONObject params, String name) {
        Object value = params == null ? null : params.opt(name);
        return value instanceof JSONObject ? (JSONObject) value : null;
    }

    /** 缺省省略该键；显式 null 传 JSON null（Manager 按无效参数拒绝）。 */
    private static CompletableFuture<JSONObject> failed(Throwable failure) {
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        future.completeExceptionally(failure);
        return future;
    }

    private static void closeObservation(BotHostManager.Observation handle) {
        if (handle == null) return;
        try {
            handle.close();
        } catch (Throwable ignored) {
        }
    }

    /** 先 SHUT_RDWR 解除阻塞中的读写，再关闭端点；重复关闭按无害处理。 */
    private static void shutdownAndClose(ParcelFileDescriptor descriptor) {
        if (descriptor == null) return;
        try {
            Os.shutdown(descriptor.getFileDescriptor(), OsConstants.SHUT_RDWR);
        } catch (ErrnoException ignored) {
        } catch (RuntimeException ignored) {
        }
        closeQuietly(descriptor);
    }

    private static void closeQuietly(Closeable target) {
        if (target == null) return;
        try {
            target.close();
        } catch (Throwable ignored) {
        }
    }
}
