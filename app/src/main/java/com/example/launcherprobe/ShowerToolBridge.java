package com.example.launcherprobe;

import android.hardware.display.DisplayManager;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.KeyEvent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

/** Routes each native tool call to the display owned by its host-authenticated conversation. */
final class ShowerToolBridge {
    // 统一 surface 的空闲保活周期：只对本 bridge 已 adopt 的 session 延寿，远小于服务端 300s 回收阈值。
    private static final long SURFACE_KEEPALIVE_MS = 60_000;
    private static final Map<String, Integer> KEYS = Map.ofEntries(
            Map.entry("BACK", KeyEvent.KEYCODE_BACK),
            Map.entry("HOME", KeyEvent.KEYCODE_HOME),
            Map.entry("ENTER", KeyEvent.KEYCODE_ENTER),
            Map.entry("TAB", KeyEvent.KEYCODE_TAB),
            Map.entry("ESCAPE", KeyEvent.KEYCODE_ESCAPE),
            Map.entry("SPACE", KeyEvent.KEYCODE_SPACE),
            Map.entry("DEL", KeyEvent.KEYCODE_DEL),
            Map.entry("A", KeyEvent.KEYCODE_A),
            Map.entry("COPY", KeyEvent.KEYCODE_COPY),
            Map.entry("CUT", KeyEvent.KEYCODE_CUT),
            Map.entry("PASTE", KeyEvent.KEYCODE_PASTE),
            Map.entry("FORWARD_DEL", KeyEvent.KEYCODE_FORWARD_DEL),
            Map.entry("DPAD_UP", KeyEvent.KEYCODE_DPAD_UP),
            Map.entry("DPAD_DOWN", KeyEvent.KEYCODE_DPAD_DOWN),
            Map.entry("DPAD_LEFT", KeyEvent.KEYCODE_DPAD_LEFT),
            Map.entry("DPAD_RIGHT", KeyEvent.KEYCODE_DPAD_RIGHT),
            Map.entry("DPAD_CENTER", KeyEvent.KEYCODE_DPAD_CENTER),
            Map.entry("PAGE_UP", KeyEvent.KEYCODE_PAGE_UP),
            Map.entry("PAGE_DOWN", KeyEvent.KEYCODE_PAGE_DOWN),
            Map.entry("MOVE_HOME", KeyEvent.KEYCODE_MOVE_HOME),
            Map.entry("MOVE_END", KeyEvent.KEYCODE_MOVE_END)
    );
    private final android.content.Context context;
    private ShowerManager manager;
    private boolean acquired;
    private boolean released;
    /** 用户接管后、重新截图前仍允许的动作：不依赖旧画面坐标。 */
    private static final java.util.Set<String> USER_DIRTY_ALLOWED = java.util.Set.of("screenshot", "create", "release");
    private final Map<String, ShowerController> controllers = new ConcurrentHashMap<>();
    private final Map<String, Integer> activeRefs = new ConcurrentHashMap<>();
    private final AtomicBoolean bridgeClosed = new AtomicBoolean();
    private final Object keepAliveLock = new Object();
    private ScheduledExecutorService surfaceKeepAlive;

    ShowerToolBridge(android.content.Context context) {
        this.context = context.getApplicationContext();
        // 非阻塞快速路径；收尾窗口内返回 null，由 run() 在 worker 上延迟阻塞获取。
        manager = ShowerManager.tryAcquire(this.context);
        acquired = manager != null;
    }

    /** 仅在 worker 执行的工具操作中调用；绝不阻塞 main/reader。 */
    private ShowerManager ensureManager() {
        ShowerManager current = manager;
        if (current != null) return current;
        synchronized (this) {
            current = manager;
            if (current == null) {
                current = ShowerManager.acquire(context);
                manager = current;
                acquired = true;
            }
        }
        return current;
    }

    private void releaseOwned() {
        ShowerManager current;
        synchronized (this) {
            if (!acquired || released) return;
            current = manager;
            released = true;
        }
        if (current != null) current.release();
    }

    JSONObject executeOwner(String ownerKey, JSONObject arguments) throws Exception {
        return executeOwner(ownerKey, arguments, null);
    }

    /** Host 原生调用（带任务取消标记）：取消后即使 Binder 忽略/清除中断也释放本次新建控制器。 */
    JSONObject executeOwner(String ownerKey, JSONObject arguments, BooleanSupplier cancelled)
            throws Exception {
        if (ownerKey == null || ownerKey.isEmpty()) {
            throw new IllegalArgumentException("Shower 操作缺少归属键");
        }
        return run(ownerKey, arguments, cancelled);
    }

    /**
     * 每个 Bot 一块屏：长度前缀编码，杜绝分隔歧义；归属只来自可信 Host metadata。
     * 同一 Bot 的主私聊、群与 DM 上下文共用这块屏。
     */
    static String ownerKey(String deviceId, String botId) {
        StringBuilder key = new StringBuilder("bot-host|");
        appendPrefixed(key, deviceId);
        appendPrefixed(key, botId);
        return key.toString();
    }

    private static void appendPrefixed(StringBuilder key, String value) {
        key.append(value.length()).append(':').append(value);
    }

    private JSONObject run(String key, JSONObject arguments, BooleanSupplier cancelled)
            throws Exception {
        if (arguments == null) throw new IllegalArgumentException("缺少 Shower 工具参数");
        if (bridgeClosed.get()) throw new IllegalStateException("Shower 工具桥已关闭");
        ShowerManager manager = ensureManager();
        if (bridgeClosed.get()) {
            releaseOwned();
            throw new IllegalStateException("Shower 工具桥已关闭");
        }
        ShowerController controller = controllers.get(key);
        boolean createdHere = false;
        if (controller == null) {
            ShowerController created = new ShowerController(context, manager);
            ShowerController raced = controllers.putIfAbsent(key, created);
            controller = raced != null ? raced : created;
            createdHere = raced == null;
        }
        if (bridgeClosed.get() || controllers.get(key) != controller) {
            if (createdHere && controllers.remove(key, controller)) releaseQuietly(controller);
            throw new IllegalStateException("Shower 工具桥已关闭");
        }
        activeRefs.merge(key, 1, Integer::sum);
        try {
            synchronized (controller) {
            boolean userOperated = controller.awaitAutomation();
            String action = arguments.optString("action", "");
            if (userOperated && !"screenshot".equals(action)) {
                throw new IllegalStateException("用户刚结束手动接管，画面可能已改变；本次操作未执行，请先 screenshot 重新定位再继续");
            }
            if (controller.isUserDirty() && !USER_DIRTY_ALLOWED.contains(action)) {
                throw new IllegalStateException("用户已接管过本屏幕并可能仍在操作，画面可能已改变；本次操作未执行，请先 screenshot 重新定位再继续");
            }
            return switch (action) {
                case "create" -> create(controller, arguments);
                case "launch" -> controller.launch(requiredString(arguments, "packageName", 255));
                case "screenshot" -> controller.screenshot(integer(arguments, "maxWidth", 720),
                        integer(arguments, "maxHeight", 1280));
                case "tap" -> controller.tap(integer(arguments, "x"), integer(arguments, "y"));
                case "swipe" -> controller.swipe(integer(arguments, "x1"), integer(arguments, "y1"),
                        integer(arguments, "x2"), integer(arguments, "y2"),
                        integer(arguments, "durationMs", 300));
                case "key" -> key(controller, arguments);
                case "text" -> controller.text(requiredString(arguments, "text", 1000, true));
                case "copy" -> controller.copy(requiredString(arguments, "text", 1000));
                case "paste" -> controller.paste();
                case "clear" -> controller.text("").put("action", "clear");
                case "release" -> controller.release();
                default -> throw new IllegalArgumentException("未知 Shower action：" + action);
            };
            }
        } finally {
            int remaining = activeRefs.merge(key, -1, Integer::sum);
            if (remaining <= 0) activeRefs.remove(key, remaining);
            // 取消/关闭时释放本次新建且无其他任务复用的控制器，避免显示泄漏。
            boolean cancelledNow = cancelled != null ? cancelled.getAsBoolean()
                    : Thread.currentThread().isInterrupted();
            if (createdHere && remaining == 0 && (cancelledNow || bridgeClosed.get())
                    && controllers.remove(key, controller)) {
                releaseQuietly(controller);
            }
        }
    }

    private static void releaseQuietly(ShowerController controller) {
        try { controller.release(); }
        catch (Exception ignored) { }
    }

    ShowerController existingController(String conversationId) {
        return conversationId == null ? null : controllers.get(conversationId);
    }

    /**
     * 统一 shower 入口：按可信 ownerKey 取/建常驻控制器。与旧 android_shower 共用同一
     * controller map，但不在取消时释放——环境跨 abort/新回合存活，只有显式 release 或宿主关闭才回收。
     */
    ShowerController surfaceController(String ownerKey) {
        if (ownerKey == null || ownerKey.isEmpty()) throw new IllegalArgumentException("Shower 操作缺少归属键");
        if (bridgeClosed.get()) throw new IllegalStateException("Shower 工具桥已关闭");
        ShowerManager manager = ensureManager();
        if (bridgeClosed.get()) {
            releaseOwned();
            throw new IllegalStateException("Shower 工具桥已关闭");
        }
        ShowerController existing = controllers.get(ownerKey);
        if (existing != null) return existing;
        ShowerController created = new ShowerController(context, manager);
        ShowerController raced = controllers.putIfAbsent(ownerKey, created);
        ShowerController controller = raced != null ? raced : created;
        if (bridgeClosed.get() || controllers.get(ownerKey) != controller) {
            if (raced == null && controllers.remove(ownerKey, created)) releaseQuietly(created);
            throw new IllegalStateException("Shower 工具桥已关闭");
        }
        return controller;
    }

    /** 只读查找：status 不得因查询而创建虚拟屏。 */
    ShowerController existingSurfaceController(String ownerKey) {
        return ownerKey == null ? null : controllers.get(ownerKey);
    }

    /**
     * 统一 surface 的 native 保活：首次 ensure/adopt 成功后由本 bridge 拥有的轻量定时器，
     * 只对已绑定 sessionId 且 binder 仍活的显示调 touchDisplay 延寿；丢失即停，不重建、不唤 Shizuku。
     */
    void startSurfaceKeepAlive() {
        synchronized (keepAliveLock) {
            if (bridgeClosed.get() || surfaceKeepAlive != null) return;
            ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "shower-surface-keepalive");
                thread.setDaemon(true);
                return thread;
            });
            surfaceKeepAlive = timer;
            timer.scheduleWithFixedDelay(this::keepSurfacesAlive,
                    SURFACE_KEEPALIVE_MS, SURFACE_KEEPALIVE_MS, TimeUnit.MILLISECONDS);
        }
    }

    private void keepSurfacesAlive() {
        boolean kept = false;
        for (ShowerController controller : controllers.values()) {
            try {
                if (controller.keepSurfaceAlive()) kept = true;
            } catch (RuntimeException ignored) {
                // 单个控制器异常不影响其他 surface；丢失的显示已由控制器 clearDisplay，不再重建。
            }
        }
        if (!kept) stopSurfaceKeepAlive(false);
    }

    /** force=false 时在锁内复核是否仍有已绑定 surface，避开与并发 ensure/adopt 的竞态。 */
    private void stopSurfaceKeepAlive(boolean force) {
        synchronized (keepAliveLock) {
            if (!force && anySurfaceBound()) return;
            ScheduledExecutorService timer = surfaceKeepAlive;
            surfaceKeepAlive = null;
            if (timer != null) timer.shutdown();
        }
    }

    private boolean anySurfaceBound() {
        for (ShowerController controller : controllers.values()) {
            if (controller.surfaceSessionId() != null) return true;
        }
        return false;
    }

    /** 主屏真实像素作为虚拟屏默认尺寸（旧 create 与统一 ensure 共用）。 */
    @SuppressWarnings("deprecation") // Real metrics are the default display's full, current logical size.
    android.util.DisplayMetrics realMetrics() {
        DisplayManager displays = context.getSystemService(DisplayManager.class);
        Display display = displays == null ? null : displays.getDisplay(Display.DEFAULT_DISPLAY);
        if (display == null) throw new IllegalStateException("无法读取系统主屏参数");
        DisplayMetrics metrics = new DisplayMetrics();
        display.getRealMetrics(metrics);
        return metrics;
    }

    private JSONObject create(ShowerController controller, JSONObject arguments) throws Exception {
        DisplayMetrics metrics = realMetrics();
        return controller.create(integer(arguments, "width", metrics.widthPixels),
                integer(arguments, "height", metrics.heightPixels),
                integer(arguments, "dpi", metrics.densityDpi),
                integer(arguments, "bitrateKbps", 500));
    }

    void shutdown() {
        if (!bridgeClosed.compareAndSet(false, true)) return;
        stopSurfaceKeepAlive(true);
        for (ShowerController controller : controllers.values()) {
            try { controller.release(); }
            catch (Exception ignored) { }
        }
        controllers.clear();
        activeRefs.clear();
        releaseOwned();
    }

    private JSONObject key(ShowerController controller, JSONObject arguments) throws Exception {
        String name = requiredString(arguments, "key", 32);
        Integer keyCode = KEYS.get(name);
        if (keyCode == null) throw new IllegalArgumentException("不支持的虚拟屏按键：" + name);
        int metaState = 0;
        JSONArray modifiers = arguments.optJSONArray("modifiers");
        if (modifiers != null) for (int index = 0; index < modifiers.length(); index++) {
            metaState |= switch (modifiers.getString(index)) {
                case "SHIFT" -> KeyEvent.META_SHIFT_ON;
                case "ALT" -> KeyEvent.META_ALT_ON;
                case "CTRL" -> KeyEvent.META_CTRL_ON;
                case "META" -> KeyEvent.META_META_ON;
                default -> throw new IllegalArgumentException("不支持的按键修饰符");
            };
        }
        return controller.key(keyCode, metaState, name);
    }

    static int integer(JSONObject arguments, String name) {
        if (!arguments.has(name)) throw new IllegalArgumentException("缺少参数 " + name);
        return integer(arguments, name, 0);
    }

    /** shower_surface 也用同一严格整数解析。 */
    static int integer(JSONObject arguments, String name, int fallback) {
        if (!arguments.has(name)) return fallback;
        Object value = arguments.opt(name);
        if (!(value instanceof Number number)) throw new IllegalArgumentException(name + " 必须是整数");
        long integer = number.longValue();
        if (number.doubleValue() != integer || integer < Integer.MIN_VALUE || integer > Integer.MAX_VALUE) {
            throw new IllegalArgumentException(name + " 必须是整数");
        }
        return (int) integer;
    }

    private static String requiredString(JSONObject arguments, String name, int maxLength) {
        return requiredString(arguments, name, maxLength, false);
    }

    private static String requiredString(JSONObject arguments, String name, int maxLength, boolean allowEmpty) {
        Object value = arguments.opt(name);
        if (!(value instanceof String text) || !allowEmpty && text.isEmpty() || text.length() > maxLength) {
            throw new IllegalArgumentException(name + " 必须是 " + (allowEmpty ? "0" : "1")
                    + ".." + maxLength + " 字符的文本");
        }
        return text;
    }
}
