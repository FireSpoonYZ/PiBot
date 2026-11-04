package com.example.launcherprobe;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.regex.Pattern;

/**
 * M18 私有 UI↔Host 桥的线路协议：帧形状、固定操作白名单、有界行读取与错误归一化。
 * 只被同包 Binder/socket 两端共享，不含 Host 业务逻辑，也不承载凭据。
 */
final class BotHostUiProtocol {

    /** 唯一 Binder 事务：一次性 token 换 socket 端点，Binder 内不传业务 JSON。 */
    static final int TRANSACTION_OPEN_SESSION = android.os.IBinder.FIRST_CALL_TRANSACTION;
    static final String DESCRIPTOR = "com.example.launcherprobe.BotHostUiBridge";

    /** 客户端生成、服务端校验并回显：端点只与本次事务配对。 */
    static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{16,64}");

    static final int MAX_LINE_BYTES = 40 * 1024 * 1024;
    static final int MAX_IN_FLIGHT = 8;
    static final int MAX_OUTPUT_FRAMES = 8;
    static final long MAX_OUTPUT_BYTES = 80L * 1024 * 1024;

    static final String TYPE_REQUEST = "request";
    static final String TYPE_RESPONSE = "response";
    static final String TYPE_EVENT = "event";

    static final String EVENT_HOST_FRAME = "hostFrame";
    static final String EVENT_VOICE = "voiceEvent";
    /** M20 客户端模式观察事件：data 即 DesktopObservationEvent {type,observationId,frame|error}。 */
    static final String EVENT_CLIENT_FRAME = "clientFrame";

    /** 只撤销本 UI 会话的观察/捕获，不关闭 Host。 */
    static final String OP_PAUSE = "pause";

    /**
     * 保留清理操作：不受普通在途上限约束，普通请求满载时仍能生效（pause/clientUnobserve）。
     * Rust 侧对应 CLIENT_CLEANUP_METHODS＝{clientUnobserve}；pause 只在 UI↔bridge 之间存在，
     * 不进 Rust 命令。
     */
    static boolean isCleanupOperation(String op) {
        return OP_PAUSE.equals(op) || "clientUnobserve".equals(op);
    }

    /**
     * 客户端观察清理（clientUnobserve）：不占普通 8 槽，改用与 Rust
     * {@code CLIENT_CLEANUP_METHODS} 对齐的独立小额度；额度满立即拒绝，不排队。
     */
    static boolean isClientCleanupOperation(String op) {
        return "clientUnobserve".equals(op);
    }

    /**
     * 固定 Host 数据操作；start/stop/openSystemSettings/reconnect/hide
     * 属 UI 本地动作，不经服务派发。拒绝任何泛化转发。
     * client* 为 M20 无参数化的客户端入口：内层 broker 操作另有 16 项白名单（Node 侧强制）。
     * UI 会话只释放自己的观察，客户端进程由应用级 broker 持有。
     */
    private static final Set<String> OPERATIONS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "snapshot", "status", "centerSettings", "saveCenterSettings", "settingsGet", "settingsSet", "saveCredentials", "call",
            "observe", "cancelObservation",
            "voiceSettings", "saveVoiceSettings", "startVoice", "finishVoice", "cancelVoice",
            "uiSettings", OP_PAUSE,
            "clientRequest", "clientObserve", "clientUnobserve", "clientChatVisibility", "clientConnectionProbe")));

    private BotHostUiProtocol() {
    }

    static boolean isOperation(String op) {
        return op != null && OPERATIONS.contains(op);
    }

    static String newToken() {
        return UUID.randomUUID().toString();
    }

    // ---------- 帧 ----------

    static JSONObject request(String id, String op, JSONObject params) {
        return object("type", TYPE_REQUEST, "id", id, "op", op,
                "params", params == null ? new JSONObject() : params);
    }

    static JSONObject response(String id, JSONObject result) {
        return object("type", TYPE_RESPONSE, "id", id, "ok", true,
                "result", result == null ? new JSONObject() : result);
    }

    static JSONObject responseError(String id, Throwable failure) {
        return object("type", TYPE_RESPONSE, "id", id, "ok", false, "error", errorObject(failure));
    }

    static JSONObject event(String event, JSONObject data) {
        return object("type", TYPE_EVENT, "event", event, "data", data == null ? new JSONObject() : data);
    }

    /** client 模式观察终态事件：data 与 DesktopObservationEvent 同形（data 即事件本身）。 */
    static JSONObject clientErrorEvent(String observationId, JSONObject error) {
        return object("type", "event", "observationId", observationId, "error", error);
    }

    /** 序列化为一行 JSON（不含换行）；超限按固定错误拒绝，不截断。 */
    static byte[] line(JSONObject frame) throws BotHostProcess.BridgeException {
        byte[] bytes = frame.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_LINE_BYTES) {
            throw new BotHostProcess.BridgeException("TOO_LARGE", "not-sent", "帧超限");
        }
        return bytes;
    }

    /** org.json 的 JSONObject(String) 不拒绝尾随垃圾，改用 Tokener 严格取整文档。 */
    static JSONObject parse(String text) throws IOException {
        JSONTokener tokener = new JSONTokener(text);
        Object value;
        boolean clean;
        try {
            value = tokener.nextValue();
            clean = tokener.nextClean() == 0;
        } catch (JSONException invalid) {
            throw new IOException("帧 JSON 解析失败");
        }
        if (!(value instanceof JSONObject) || !clean) throw new IOException("帧 JSON 解析失败");
        return (JSONObject) value;
    }

    /** null 值省略键（与旧插件条件 put 等价），JSONObject.NULL 保留显式 null。 */
    static JSONObject object(Object... values) {
        JSONObject result = new JSONObject();
        try {
            for (int i = 0; i + 1 < values.length; i += 2) result.put(String.valueOf(values[i]), values[i + 1]);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
        return result;
    }

    // ---------- 错误归一化 ----------

    static JSONObject errorObject(Throwable failure) {
        Throwable t = unwrap(failure);
        String code = errorCode(t);
        return object("code", code != null ? code : "INTERNAL",
                "outcome", errorOutcome(t),
                "message", safeMessage(t));
    }

    /** 对端错误对象还原为固定 code/outcome，绝不透传任意 cause。 */
    static BotHostProcess.BridgeException bridgeError(JSONObject error) {
        String code = error == null ? "" : error.optString("code", "");
        String outcome = error == null || !error.has("outcome") || error.isNull("outcome")
                ? null : error.optString("outcome", null);
        String message = error == null ? null : error.optString("message", null);
        if (code.isEmpty()) code = "PROTOCOL";
        if (message == null || message.trim().isEmpty()) message = "操作失败";
        if (message.length() > 512) message = message.substring(0, 512);
        return new BotHostProcess.BridgeException(code, outcome, message);
    }

    static String errorCode(Throwable failure) {
        Throwable t = unwrap(failure);
        if (t instanceof BotHostProcess.BridgeException bridge) return bridge.code;
        return null;
    }

    static String errorOutcome(Throwable failure) {
        Throwable t = unwrap(failure);
        if (t instanceof BotHostProcess.BridgeException bridge) return bridge.outcome;
        return null;
    }

    static String safeMessage(Throwable failure) {
        Throwable t = unwrap(failure);
        String message = t.getMessage();
        if (message == null || message.trim().isEmpty()) return "操作失败";
        // 仅透出有界 Bridge 消息与受控业务异常；其余保持通用，避免泄露内部细节/凭据。
        if (t instanceof BotHostProcess.BridgeException) {
            return message.length() > 512 ? message.substring(0, 512) : message;
        }
        if (t instanceof IllegalArgumentException || t instanceof IllegalStateException) return message;
        return "操作失败";
    }

    /** 解包 CompletableFuture 包装（CompletionException/ExecutionException），保留内部 code/outcome。 */
    static Throwable unwrap(Throwable failure) {
        Throwable current = failure;
        while ((current instanceof CompletionException || current instanceof ExecutionException)
                && current.getCause() != null && current.getCause() != current) {
            current = current.getCause();
        }
        return current;
    }

    /** 共享的可空探针：参数无效时按受控业务错误拒绝。 */
    static String optionalString(JSONObject params, String name) {
        if (params == null || !params.has(name)) return null;
        Object value = params.opt(name);
        if (!(value instanceof String)) throw new IllegalArgumentException(name + " 无效");
        return (String) value;
    }

    // ---------- 有界行读取（服务端与客户端共用） ----------

    /** 有界逐行读取：UTF-8 原始行 ≤ maxLine（不含换行符），非法编码/超限抛错，EOF 返回 null。 */
    static final class LineReader {
        private final int maxLine;
        private final CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        private byte[] buffer = new byte[8192];
        private int fill;
        private int scan;
        private int lineStart;

        LineReader(int maxLine) {
            this.maxLine = maxLine;
        }

        String readLine(InputStream in) throws IOException {
            while (true) {
                if (scan < fill) {
                    for (; scan < fill; scan++) {
                        if (buffer[scan] != '\n') continue;
                        int length = scan - lineStart;
                        if (length > maxLine) throw new IOException("帧超限");
                        String line = decode(buffer, lineStart, length);
                        lineStart = scan + 1;
                        scan = lineStart;
                        return line;
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
                    int nextSize = Math.min(buffer.length * 2, maxLine + 1);
                    byte[] grown = new byte[nextSize];
                    System.arraycopy(buffer, 0, grown, 0, fill);
                    buffer = grown;
                }
                int count = in.read(buffer, fill, buffer.length - fill);
                if (count < 0) {
                    if (fill == lineStart) return null;
                    int length = fill - lineStart;
                    if (length > maxLine) throw new IOException("帧超限");
                    String line = decode(buffer, lineStart, length);
                    fill = lineStart;
                    scan = lineStart;
                    return line;
                }
                fill += count;
            }
        }

        private String decode(byte[] bytes, int offset, int length) throws IOException {
            try {
                CharBuffer chars = decoder.decode(ByteBuffer.wrap(bytes, offset, length));
                return chars.toString();
            } catch (CharacterCodingException invalid) {
                throw new IOException("帧非 UTF-8");
            }
        }
    }
}
