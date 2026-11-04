package com.example.launcherprobe;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.view.KeyEvent;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.BooleanSupplier;

/**
 * 统一 Shower（host.shower）的 Android 原生适配层。只由私有 shower_surface 原生工具进入，
 * 复用 ShowerToolBridge 的 controller map 与可信 ownerKey；旧 android_shower 的工具语义
 * （含手动接管交还等待）保持不变。这里不持有任何真实锁/凭据，也不做通用执行。
 */
final class ShowerSurfaceBridge {
    static final String PLATFORM = "android";
    static final int DEFAULT_FRAME_WIDTH = 1280;
    static final int DEFAULT_FRAME_HEIGHT = 800;
    static final int MAX_FRAME_BASE64_BYTES = 720 * 1024; // 与 shower-protocol 的绝对 base64 预算一致
    private static final int MAX_PNG_WIDTH = 1440; // 现有 Binder 截图请求上限
    private static final int MAX_PNG_HEIGHT = 3200;
    private static final int BITRATE_KBPS = 500;
    private static final int[] JPEG_QUALITIES = {82, 68, 52, 36, 22};
    private static final int SCROLL_PX_PER_NOTCH = 80;
    private static final int MAX_SCROLL_PX = 1200;
    private static final Set<String> ACTIONS =
            Set.of("status", "ensure", "frame", "input", "launch", "release");
    private static final Set<String> SOURCES = Set.of("agent", "human");
    // 固定毫秒精度 ISO 时间戳，避免 JS Date.parse 对变长小数位的解析差异。
    private static final DateTimeFormatter TIMESTAMP =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT)
                    .withZone(ZoneOffset.UTC);
    private static final Map<String, Integer> KEYS;
    private static final List<String> KEY_NAMES;

    static {
        Map<String, Integer> keys = new LinkedHashMap<>();
        keys.put("ENTER", KeyEvent.KEYCODE_ENTER);
        keys.put("TAB", KeyEvent.KEYCODE_TAB);
        keys.put("ESCAPE", KeyEvent.KEYCODE_ESCAPE);
        keys.put("SPACE", KeyEvent.KEYCODE_SPACE);
        keys.put("BACKSPACE", KeyEvent.KEYCODE_DEL);
        keys.put("DELETE", KeyEvent.KEYCODE_FORWARD_DEL);
        keys.put("LEFT", KeyEvent.KEYCODE_DPAD_LEFT);
        keys.put("RIGHT", KeyEvent.KEYCODE_DPAD_RIGHT);
        keys.put("UP", KeyEvent.KEYCODE_DPAD_UP);
        keys.put("DOWN", KeyEvent.KEYCODE_DPAD_DOWN);
        keys.put("HOME", KeyEvent.KEYCODE_MOVE_HOME);
        keys.put("END", KeyEvent.KEYCODE_MOVE_END);
        keys.put("PAGEUP", KeyEvent.KEYCODE_PAGE_UP);
        keys.put("PAGEDOWN", KeyEvent.KEYCODE_PAGE_DOWN);
        for (char letter = 'A'; letter <= 'Z'; letter++) {
            keys.put(String.valueOf(letter), KeyEvent.KEYCODE_A + (letter - 'A'));
        }
        for (int digit = 0; digit <= 9; digit++) {
            keys.put(String.valueOf(digit), KeyEvent.KEYCODE_0 + digit);
        }
        for (int index = 0; index < 12; index++) {
            keys.put("F" + (index + 1), KeyEvent.KEYCODE_F1 + index);
        }
        keys.put("BACK", KeyEvent.KEYCODE_BACK);
        keys.put("ANDROID_HOME", KeyEvent.KEYCODE_HOME);
        KEYS = Collections.unmodifiableMap(keys);
        KEY_NAMES = Collections.unmodifiableList(new ArrayList<>(keys.keySet()));
    }

    private ShowerSurfaceBridge() { }

    /**
     * 一次 shower_surface 调用。失败以带共享协议错误码的 Failure 抛出，由
     * BotHostNativeTools 转成 native_result 错误帧，Android 后端得以保留原语义。
     */
    static JSONObject execute(ShowerToolBridge tools, JSONObject context, JSONObject arguments,
            BooleanSupplier cancelled) throws Exception {
        try {
            return run(tools, context, arguments, cancelled);
        } catch (Failure failure) {
            throw failure;
        } catch (InterruptedException interrupted) {
            throw new Failure("CANCELLED", "虚拟屏操作已取消");
        } catch (IllegalArgumentException invalid) {
            throw new Failure("INVALID_ARGUMENT", "shower_surface 参数无效");
        } catch (android.os.RemoteException dead) {
            throw new Failure("SHOWER_BACKEND_FAILED", "虚拟屏服务不可用");
        } catch (Exception other) {
            throw new Failure("SHOWER_BACKEND_FAILED", "虚拟屏操作失败");
        }
    }

    private static JSONObject run(ShowerToolBridge tools, JSONObject context, JSONObject arguments,
            BooleanSupplier cancelled) throws Exception {
        if (arguments == null) throw new IllegalArgumentException("缺少 shower_surface 参数");
        String action = arguments.optString("action", "");
        if (!ACTIONS.contains(action)) throw new IllegalArgumentException("未知 shower action");
        // source 只来自可信调用点（agent 工具/human 控制），绝不来自模型参数。
        if (!SOURCES.contains(arguments.optString("source", ""))) {
            throw new IllegalArgumentException("shower_surface 只接受可信 source");
        }
        String ownerKey = ShowerToolBridge.ownerKey(context.optString("deviceId"),
                context.optString("botId"));
        // ownerKey 只来自可信 actor（与旧 android_shower 同一算法/同一 map，保证共屏）；
        // sessionId 只作为绑定/校验的 epoch，从不参与归属。
        String sessionId = sessionId(arguments);
        if ("status".equals(action)) {
            return status(tools.existingSurfaceController(ownerKey), sessionId);
        }
        if ("ensure".equals(action)) {
            android.util.DisplayMetrics metrics = tools.realMetrics();
            JSONObject options = arguments.optJSONObject("options");
            int width = options == null ? metrics.widthPixels
                    : ShowerToolBridge.integer(options, "width", metrics.widthPixels);
            int height = options == null ? metrics.heightPixels
                    : ShowerToolBridge.integer(options, "height", metrics.heightPixels);
            JSONObject result = ensure(tools.surfaceController(ownerKey), sessionId, width, height,
                    metrics.densityDpi, cancelled);
            // adopt 成功后该 surface 才由本 bridge 保活；status/frame 等只读路径不启动保活。
            tools.startSurfaceKeepAlive();
            return result;
        }
        ShowerController controller = existingController(tools, ownerKey);
        return switch (action) {
            case "frame" -> frame(controller, sessionId, arguments.optJSONObject("limits"), cancelled);
            case "input" -> input(controller, sessionId, arguments.optJSONObject("input"), cancelled);
            case "launch" -> launch(controller, sessionId, arguments.optJSONObject("target"), cancelled);
            case "release" -> release(controller, sessionId);
            default -> throw new IllegalArgumentException("未知 shower action");
        };
    }

    private static String sessionId(JSONObject arguments) {
        if (!arguments.has("sessionId") || arguments.isNull("sessionId")) return null;
        String value = arguments.optString("sessionId", "");
        if (value.isEmpty()) throw new IllegalArgumentException("sessionId 必须是非空字符串");
        return value;
    }

    private static ShowerController existingController(ShowerToolBridge tools, String ownerKey)
            throws Failure {
        ShowerController controller = tools.existingSurfaceController(ownerKey);
        if (controller == null) throw new Failure("SHOWER_SESSION_NOT_FOUND", "虚拟屏尚未创建");
        return controller;
    }

    /**
     * status 永远返回完整 Session（phase/width/height/capabilities/updatedAt）；只读：
     * 不建虚拟屏、不触碰 Shizuku/ensureService，也不延长空闲寿命。
     */
    private static JSONObject status(ShowerController controller, String sessionId) throws Exception {
        if (controller == null) return session(null, "idle", 0, 0);
        try {
            if (!controller.hasDisplay()) {
                return session(null, sessionId == null ? "idle" : "closed", 0, 0);
            }
            return session(controller.surfaceSessionId(), "ready",
                    controller.surfaceWidth(), controller.surfaceHeight());
        } catch (android.os.RemoteException dead) {
            return session(null, "error", 0, 0).put("error", new JSONObject()
                    .put("code", "SHOWER_BACKEND_FAILED").put("message", "虚拟屏服务不可用"));
        }
    }

    private static JSONObject ensure(ShowerController controller, String sessionId, int width,
            int height, int dpi, BooleanSupplier cancelled) throws Exception {
        if (sessionId == null) throw new IllegalArgumentException("ensure 需要 sessionId");
        checkCancelled(cancelled);
        JSONObject created = controller.create(width, height, dpi, BITRATE_KBPS);
        // manager 首次 ensure 前分配的 UUID 在这里绑定；复用原虚拟屏时不重建显示。
        controller.adoptSurfaceSession(sessionId);
        return session(sessionId, "ready", controller.surfaceWidth(), controller.surfaceHeight())
                .put("reused", created.optBoolean("reused"));
    }

    /** frame 不等待本机手动接管交还，也不重建/改变虚拟屏尺寸。 */
    private static JSONObject frame(ShowerController controller, String sessionId, JSONObject limits,
            BooleanSupplier cancelled) throws Exception {
        requireReady(controller, sessionId);
        int maxWidth = limits == null ? DEFAULT_FRAME_WIDTH
                : ShowerToolBridge.integer(limits, "maxWidth", DEFAULT_FRAME_WIDTH);
        int maxHeight = limits == null ? DEFAULT_FRAME_HEIGHT
                : ShowerToolBridge.integer(limits, "maxHeight", DEFAULT_FRAME_HEIGHT);
        int maxBytes = limits == null ? MAX_FRAME_BASE64_BYTES
                : ShowerToolBridge.integer(limits, "maxBytes", MAX_FRAME_BASE64_BYTES);
        if (maxWidth < 160 || maxWidth > 4096 || maxHeight < 160 || maxHeight > 4096) {
            throw new IllegalArgumentException("maxWidth/maxHeight 范围为 160..4096");
        }
        if (maxBytes < 1 || maxBytes > MAX_FRAME_BASE64_BYTES) {
            throw new IllegalArgumentException("maxBytes 范围为 1.." + MAX_FRAME_BASE64_BYTES);
        }
        checkCancelled(cancelled);
        int sourceWidth = controller.surfaceWidth();
        int sourceHeight = controller.surfaceHeight();
        byte[] png = controller.capturePng(Math.min(maxWidth, MAX_PNG_WIDTH),
                Math.min(maxHeight, MAX_PNG_HEIGHT));
        checkCancelled(cancelled);
        return encodeJpeg(png, maxWidth, maxHeight, maxBytes, cancelled)
                .put("ok", true)
                .put("sessionId", sessionId)
                .put("frameId", UUID.randomUUID().toString())
                .put("capturedAt", TIMESTAMP.format(Instant.now()))
                .put("width", sourceWidth)
                .put("height", sourceHeight);
    }

    /** PNG 只在内存里转一次 JPEG：先按 limits 等比缩小，再逐级降质量直到符合 base64 预算。 */
    private static JSONObject encodeJpeg(byte[] png, int maxWidth, int maxHeight, int maxBytes,
            BooleanSupplier cancelled) throws Exception {
        Bitmap decoded = BitmapFactory.decodeByteArray(png, 0, png.length);
        if (decoded == null) throw new Failure("SHOWER_BACKEND_FAILED", "无法解码虚拟屏截图");
        try {
            double scale = Math.min(1.0, Math.min(maxWidth / (double) decoded.getWidth(),
                    maxHeight / (double) decoded.getHeight()));
            int frameWidth = Math.max(1, (int) Math.round(decoded.getWidth() * scale));
            int frameHeight = Math.max(1, (int) Math.round(decoded.getHeight() * scale));
            for (int attempt = 0; attempt < 5; attempt++) {
                checkCancelled(cancelled);
                Bitmap frame = Bitmap.createScaledBitmap(decoded, frameWidth, frameHeight, true);
                try {
                    for (int quality : JPEG_QUALITIES) {
                        byte[] jpeg = compress(frame, quality);
                        if (base64Length(jpeg.length) <= maxBytes) {
                            return new JSONObject().put("imageWidth", frameWidth)
                                    .put("imageHeight", frameHeight)
                                    .put("mimeType", "image/jpeg")
                                    .put("data", Base64.encodeToString(jpeg, Base64.NO_WRAP));
                        }
                    }
                } finally {
                    if (frame != decoded) frame.recycle();
                }
                frameWidth = Math.max(1, frameWidth * 3 / 4);
                frameHeight = Math.max(1, frameHeight * 3 / 4);
            }
            throw new Failure("SHOWER_FRAME_TOO_LARGE", "截图无法压缩到帧预算内");
        } finally {
            decoded.recycle();
        }
    }

    private static JSONObject input(ShowerController controller, String sessionId, JSONObject input,
            BooleanSupplier cancelled) throws Exception {
        requireReady(controller, sessionId);
        if (input == null) throw new IllegalArgumentException("缺少 input");
        return switch (input.optString("type", "")) {
            case "click" -> click(controller, input, cancelled);
            case "drag" -> drag(controller, input, cancelled);
            case "scroll" -> scroll(controller, input, cancelled);
            case "key" -> key(controller, input, cancelled);
            case "text" -> text(controller, input, cancelled);
            default -> throw new Failure("SHOWER_UNSUPPORTED", "不支持的输入类型");
        };
    }

    private static JSONObject click(ShowerController controller, JSONObject input,
            BooleanSupplier cancelled) throws Exception {
        int x = ShowerToolBridge.integer(input, "x");
        int y = ShowerToolBridge.integer(input, "y");
        String button = input.optString("button", "left");
        int count = ShowerToolBridge.integer(input, "count", 1);
        if (count != 1 && count != 2) throw new IllegalArgumentException("count 只能为 1 或 2");
        if (!"left".equals(button)) {
            throw new Failure("SHOWER_UNSUPPORTED", "Android 虚拟屏只支持左键点击");
        }
        checkCancelled(cancelled);
        controller.tap(x, y);
        if (count == 2) {
            checkCancelled(cancelled);
            controller.tap(x, y);
        }
        return new JSONObject().put("ok", true).put("action", "input").put("type", "click")
                .put("x", x).put("y", y).put("count", count);
    }

    private static JSONObject drag(ShowerController controller, JSONObject input,
            BooleanSupplier cancelled) throws Exception {
        int x1 = ShowerToolBridge.integer(input, "x1");
        int y1 = ShowerToolBridge.integer(input, "y1");
        int x2 = ShowerToolBridge.integer(input, "x2");
        int y2 = ShowerToolBridge.integer(input, "y2");
        int durationMs = ShowerToolBridge.integer(input, "durationMs", 300);
        if (durationMs < 50 || durationMs > 3000) {
            throw new IllegalArgumentException("durationMs 范围为 50..3000");
        }
        checkCancelled(cancelled);
        controller.swipe(x1, y1, x2, y2, durationMs);
        return new JSONObject().put("ok", true).put("action", "input").put("type", "drag")
                .put("x1", x1).put("y1", y1).put("x2", x2).put("y2", y2)
                .put("durationMs", durationMs);
    }

    /**
     * 滚动格数映射为有界 swipe：每格固定 80px，单次最多 1200px；正 deltaY = 内容向下滚动
     * （手指上滑）。横向滚动没有等价注入方式，明确报 SHOWER_UNSUPPORTED，不做近似。
     * shortcut: 固定 80px/格而非逐应用行高，需要像素级滚动精度时改用 MotionEvent 序列注入。
     */
    private static JSONObject scroll(ShowerController controller, JSONObject input,
            BooleanSupplier cancelled) throws Exception {
        int x = ShowerToolBridge.integer(input, "x");
        int y = ShowerToolBridge.integer(input, "y");
        int deltaX = ShowerToolBridge.integer(input, "deltaX", 0);
        int deltaY = ShowerToolBridge.integer(input, "deltaY");
        if (deltaX < -20 || deltaX > 20 || deltaY < -20 || deltaY > 20) {
            throw new IllegalArgumentException("滚动格数范围为 -20..20");
        }
        if (deltaX == 0 && deltaY == 0) throw new IllegalArgumentException("滚动方向不能为空");
        if (deltaX != 0) throw new Failure("SHOWER_UNSUPPORTED", "Android 虚拟屏不支持横向滚动");
        int displayWidth = controller.surfaceWidth();
        int displayHeight = controller.surfaceHeight();
        if (displayWidth <= 0 || displayHeight <= 0) {
            throw new Failure("SHOWER_SESSION_NOT_FOUND", "虚拟屏会话不存在或已回收");
        }
        int distance = Math.min(Math.abs(deltaY) * SCROLL_PX_PER_NOTCH, MAX_SCROLL_PX);
        int startY = clamp(deltaY > 0 ? y + distance / 2 : y - distance / 2, displayHeight);
        int endY = clamp(deltaY > 0 ? startY - distance : startY + distance, displayHeight);
        int startX = clamp(x, displayWidth);
        if (startY == endY) throw new Failure("SHOWER_UNSUPPORTED", "当前虚拟屏高度不足以映射该滚动");
        checkCancelled(cancelled);
        controller.swipe(startX, startY, startX, endY, Math.min(1000, 150 + Math.abs(deltaY) * 60));
        return new JSONObject().put("ok", true).put("action", "input").put("type", "scroll")
                .put("x", startX).put("y", startY).put("deltaX", 0).put("deltaY", deltaY);
    }

    private static JSONObject key(ShowerController controller, JSONObject input,
            BooleanSupplier cancelled) throws Exception {
        String name = input.optString("key", "");
        Integer code = KEYS.get(name);
        if (code == null) throw new Failure("SHOWER_UNSUPPORTED", "不支持的按键");
        int metaState = 0;
        JSONArray modifiers = input.optJSONArray("modifiers");
        if (modifiers != null) {
            for (int index = 0; index < modifiers.length(); index++) {
                metaState |= switch (modifiers.getString(index)) {
                    case "SHIFT" -> KeyEvent.META_SHIFT_ON;
                    case "ALT" -> KeyEvent.META_ALT_ON;
                    case "CTRL" -> KeyEvent.META_CTRL_ON;
                    case "META" -> KeyEvent.META_META_ON;
                    default -> throw new IllegalArgumentException("不支持的按键修饰符");
                };
            }
        }
        checkCancelled(cancelled);
        controller.key(code, metaState, name);
        return new JSONObject().put("ok", true).put("action", "input").put("type", "key").put("key", name);
    }

    private static JSONObject text(ShowerController controller, JSONObject input,
            BooleanSupplier cancelled) throws Exception {
        String text = input.optString("text", "");
        if (text.isEmpty() || text.length() > 1000) {
            throw new IllegalArgumentException("text 长度范围为 1..1000");
        }
        checkCancelled(cancelled);
        controller.surfaceText(text);
        return new JSONObject().put("ok", true).put("action", "input").put("type", "text")
                .put("characters", text.length());
    }

    private static JSONObject launch(ShowerController controller, String sessionId, JSONObject target,
            BooleanSupplier cancelled) throws Exception {
        requireReady(controller, sessionId);
        if (target == null) throw new IllegalArgumentException("缺少 target");
        if (!"app".equals(target.optString("kind", ""))) {
            throw new Failure("SHOWER_UNSUPPORTED", "Android 虚拟屏只能启动应用");
        }
        String appId = target.optString("appId", "");
        checkCancelled(cancelled);
        JSONObject result = controller.launch(appId);
        return new JSONObject().put("ok", true).put("action", "launch")
                .put("sessionId", sessionId).put("appId", result.optString("packageName"));
    }

    /** 显式释放：唯一会销毁已存在虚拟屏的 shower 入口（空闲回收仍由服务端负责）。 */
    private static JSONObject release(ShowerController controller, String sessionId) throws Exception {
        if (sessionId == null) throw new IllegalArgumentException("release 需要 sessionId");
        String current = controller.surfaceSessionId();
        if (current != null && !current.isEmpty() && !current.equals(sessionId)) {
            throw new Failure("SHOWER_SESSION_MISMATCH", "会话与当前虚拟屏不匹配");
        }
        if (!controller.hasDisplay()) {
            return new JSONObject().put("ok", true).put("action", "release").put("phase", "closed")
                    .put("released", false);
        }
        JSONObject result = controller.release();
        return new JSONObject().put("ok", true).put("action", "release").put("phase", "closed")
                .put("released", result.optBoolean("released"));
    }

    /** 严格归属：会话不存在/已被替换时不操作，也不隐式重建虚拟屏。 */
    private static void requireReady(ShowerController controller, String sessionId) throws Exception {
        if (sessionId == null) throw new IllegalArgumentException("需要 sessionId");
        if (!controller.hasDisplay()) {
            throw new Failure("SHOWER_SESSION_NOT_FOUND", "虚拟屏会话不存在或已回收");
        }
        String current = controller.surfaceSessionId();
        if (current == null || current.isEmpty()) {
            throw new Failure("SHOWER_SESSION_NOT_FOUND", "虚拟屏会话尚未建立");
        }
        if (!current.equals(sessionId)) {
            throw new Failure("SHOWER_SESSION_MISMATCH", "会话与当前虚拟屏不匹配");
        }
    }

    private static void checkCancelled(BooleanSupplier cancelled) throws InterruptedException {
        if (Thread.currentThread().isInterrupted() || cancelled != null && cancelled.getAsBoolean()) {
            throw new InterruptedException("虚拟屏操作已取消");
        }
    }

    private static int clamp(int value, int limit) {
        return Math.max(0, Math.min(limit - 1, value));
    }

    private static long base64Length(int bytes) {
        return ((long) bytes + 2) / 3 * 4;
    }

    private static byte[] compress(Bitmap bitmap, int quality) {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output);
        return output.toByteArray();
    }

    private static JSONObject session(String sessionId, String phase, int width, int height)
            throws JSONException {
        return new JSONObject().put("ok", true).put("platform", PLATFORM)
                .put("sessionId", sessionId == null ? JSONObject.NULL : sessionId)
                .put("phase", phase).put("width", width).put("height", height)
                .put("capabilities", new JSONObject()
                        .put("launchKinds", new JSONArray().put("app"))
                        .put("inputKinds", new JSONArray().put("click").put("drag").put("scroll")
                                .put("key").put("text"))
                        .put("keys", new JSONArray(KEY_NAMES))
                        .put("nativePreview", true))
                .put("updatedAt", TIMESTAMP.format(Instant.now()));
    }

    /** 已分类的协议失败：code 是共享 shower 协议的错误码，由原生桥转为错误帧。 */
    static final class Failure extends Exception {
        final String code;

        Failure(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
