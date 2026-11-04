package com.example.launcherprobe;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.graphics.BitmapFactory;
import android.view.KeyEvent;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.util.Base64;

import com.ai.assistance.shower.IShowerClient;
import com.ai.assistance.shower.IShowerGesture;
import com.ai.assistance.shower.IShowerService;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;

/** Owns one conversation's Operit Shower display; the manager/service is shared across chats. */
final class ShowerController {
    private static final int MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
    private final ShowerManager manager;
    private final ClipboardManager clipboard;
    private Integer displayId;
    private int width;
    private int height;
    private int dpi;
    private IBinder displayService;
    private IShowerClient clientToken;
    private volatile Preview preview;
    private boolean manualControl;
    /** 新 Host Bot 屏幕面板的接管：用户输入与 Agent 工具并行，不阻塞工具。 */
    private volatile boolean userControl;
    /** 用户接管过且 Agent 尚未重新截图：非截图动作拒绝执行，避免按旧画面坐标操作。 */
    private volatile boolean userDirty;
    private String surfaceSessionId;
    private final java.util.LinkedHashSet<String> launchedPackages = new java.util.LinkedHashSet<>();

    static final class Preview {
        final int displayId, width, height;
        final IShowerService service;
        final IShowerClient token = new IShowerClient.Stub() { };
        Preview(int displayId, int width, int height, IShowerService service) {
            this.displayId = displayId; this.width = width; this.height = height; this.service = service;
        }
    }

    ShowerController(android.content.Context context, ShowerManager manager) {
        this.manager = manager;
        clipboard = context.getApplicationContext().getSystemService(ClipboardManager.class);
    }

    synchronized JSONObject create(int requestedWidth, int requestedHeight, int requestedDpi,
            int bitrateKbps) throws Exception {
        try {
            return createDisplay(requestedWidth, requestedHeight, requestedDpi, bitrateKbps);
        } catch (android.os.DeadObjectException exception) {
            // The server may reach its idle deadline between the alive check and the Binder call.
            clearDisplay();
            return createDisplay(requestedWidth, requestedHeight, requestedDpi, bitrateKbps);
        }
    }

    private JSONObject createDisplay(int requestedWidth, int requestedHeight, int requestedDpi,
            int bitrateKbps) throws Exception {
        int alignedWidth = align(requestedWidth);
        int alignedHeight = align(requestedHeight);
        validateDisplay(alignedWidth, alignedHeight, requestedDpi, bitrateKbps);
        IShowerService service = manager.ensureService();
        if (displayId != null && service.asBinder() == displayService && width == alignedWidth
                && height == alignedHeight && dpi == requestedDpi && service.touchDisplay(displayId)) {
            return state("create").put("reused", true);
        }
        if (displayId != null && service.asBinder() == displayService) {
            try {
                service.destroyDisplay(displayId);
            } finally {
                clearDisplay();
            }
        } else {
            clearDisplay();
        }
        int created = service.ensureDisplay(alignedWidth, alignedHeight, requestedDpi, bitrateKbps);
        if (created <= 0) throw new IllegalStateException("Operit Shower 未创建虚拟屏");
        if (Thread.currentThread().isInterrupted()) {
            try { service.destroyDisplay(created); }
            catch (Exception ignored) { }
            throw new InterruptedException("Operit Shower 创建已取消");
        }
        IShowerClient token = new IShowerClient.Stub() { };
        try {
            if (!service.attachClient(created, token)) {
                throw new IllegalStateException("Operit Shower 未绑定虚拟屏生命周期");
            }
        } catch (Exception exception) {
            try { service.destroyDisplay(created); }
            catch (Exception ignored) { }
            throw exception;
        }
        displayId = created;
        width = alignedWidth;
        height = alignedHeight;
        dpi = requestedDpi;
        displayService = service.asBinder();
        clientToken = token;
        return state("create").put("reused", false);
    }

    /** Does not create a display or extend its idle lifetime. Called off the UI thread. */
    synchronized boolean hasDisplay() throws android.os.RemoteException {
        IShowerService service = manager.aliveService();
        if (displayId == null) return false;
        if (service == null || service.asBinder() != displayService || !service.hasDisplay(displayId)) {
            clearDisplay();
            return false;
        }
        return true;
    }

    synchronized Preview openPreview(android.view.Surface surface) throws Exception {
        IShowerService service = activeService();
        int[] size = displaySize();
        if (size == null) throw new IllegalStateException("虚拟屏已结束");
        Preview next = new Preview(displayId, size[0], size[1], service);
        if (!service.setPreviewSurface(displayId, surface, next.token)) {
            throw new IllegalStateException("无法连接虚拟桌面画面");
        }
        preview = next;
        manualControl = false;
        userControl = false;
        notifyAll();
        return next;
    }

    /** 当前虚拟屏 {width, height, dpi}；没有屏幕时返回 null。不创建屏幕，也不延长空闲时间。 */
    synchronized int[] displaySize() throws android.os.RemoteException {
        if (!hasDisplay()) return null;
        int[] size = manager.aliveService().getDisplaySize(displayId);
        return size == null ? null : new int[] {size[0], size[1], dpi};
    }

    synchronized boolean keepPreviewAlive(Preview current) throws Exception {
        return preview == current && hasDisplay() && current.service.touchDisplay(current.displayId);
    }

    synchronized void closePreview(Preview current) throws Exception {
        if (preview != current) return;
        // Unblock waiting tools even if the service has died.
        preview = null;
        manualControl = false;
        userControl = false;
        notifyAll();
        current.service.setPreviewSurface(current.displayId, null, current.token);
    }

    /**
     * Bot 屏幕面板接管：拿到控制器锁说明 Agent 当前动作已结束（调用方先中断在途工具），
     * 之后接受用户输入，并要求 Agent 下一次非截图动作前重新截图。不阻塞后续工具调用。
     */
    synchronized void takeover(Preview current) {
        requirePreview(current);
        userControl = true;
        userDirty = true;
    }

    boolean isUserDirty() {
        return userDirty;
    }

    /** 与 Agent 工具并行：不取控制器锁，只校验仍是当前画面且已接管。 */
    void userTouch(Preview current, android.view.MotionEvent event) throws Exception {
        if (preview != current || !userControl) throw new IllegalStateException("请先接管操作");
        if (!current.service.injectTouch(current.displayId, event)) {
            throw new IllegalStateException("虚拟桌面触摸注入失败");
        }
    }

    synchronized void setManualControl(Preview current, boolean enabled) throws Exception {
        requirePreview(current);
        manualControl = enabled;
        notifyAll();
    }

    synchronized boolean awaitAutomation() throws InterruptedException {
        boolean waited = manualControl;
        while (manualControl) wait();
        if (Thread.currentThread().isInterrupted()) throw new InterruptedException("虚拟屏操作已取消");
        return waited;
    }

    synchronized void touch(Preview current, android.view.MotionEvent event) throws Exception {
        requireManual(current);
        if (!current.service.injectTouch(current.displayId, event)) {
            throw new IllegalStateException("虚拟桌面触摸注入失败");
        }
    }

    synchronized void previewKey(Preview current, int code) throws Exception {
        requireManual(current);
        key(code, 0, android.view.KeyEvent.keyCodeToString(code));
    }

    synchronized java.util.List<String> recentPackages(Preview current) {
        requireManual(current);
        java.util.List<String> recent = new java.util.ArrayList<>(launchedPackages);
        java.util.Collections.reverse(recent);
        return recent;
    }

    synchronized void previewLaunch(Preview current, String packageName) throws Exception {
        requireManual(current);
        launch(packageName);
    }

    synchronized void previewText(Preview current, String value) throws Exception {
        requireManual(current);
        text(value);
    }

    private void requirePreview(Preview current) {
        if (preview != current || displayId == null || displayId != current.displayId) {
            throw new IllegalStateException("虚拟桌面已结束或画面已在其他页面打开");
        }
    }

    private void requireManual(Preview current) {
        requirePreview(current);
        if (!manualControl) throw new IllegalStateException("请先接管操作");
    }

    synchronized JSONObject launch(String packageName) throws Exception {
        if (packageName == null || !packageName.matches(
                "[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+")) {
            throw new IllegalArgumentException("packageName 格式无效");
        }
        IShowerService service = activeService();
        if (!service.launchApp(packageName, displayId)) {
            throw new IllegalStateException("应用不存在、不可启动或系统拒绝在虚拟屏启动");
        }
        launchedPackages.remove(packageName);
        launchedPackages.add(packageName);
        return state("launch").put("packageName", packageName);
    }

    synchronized JSONObject screenshot(int maxWidth, int maxHeight) throws Exception {
        byte[] png = requestPng(maxWidth, maxHeight);
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(png, 0, png.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IllegalStateException("无法读取截图尺寸");
        }
        userDirty = false;
        return state("screenshot").put("imageWidth", bounds.outWidth)
                .put("imageHeight", bounds.outHeight).put("mimeType", "image/png")
                .put("data", Base64.encodeToString(png, Base64.NO_WRAP));
    }

    /** 统一 shower_surface：复用现有 PNG 获取，JPEG 缩放与 base64 预算在协议层完成。 */
    synchronized byte[] capturePng(int maxWidth, int maxHeight) throws Exception {
        return requestPng(maxWidth, maxHeight);
    }

    synchronized int surfaceWidth() throws android.os.RemoteException {
        int[] size = displaySize();
        return size == null ? 0 : size[0];
    }

    synchronized int surfaceHeight() throws android.os.RemoteException {
        int[] size = displaySize();
        return size == null ? 0 : size[1];
    }

    synchronized String surfaceSessionId() {
        return surfaceSessionId;
    }

    /** manager 在首次 ensure 前分配 UUID；虚拟屏复用时只绑定该会话，不重建显示。 */
    synchronized void adoptSurfaceSession(String sessionId) {
        surfaceSessionId = sessionId;
    }

    /**
     * 统一 surface 的空闲保活：只对已绑定 sessionId 且 binder 仍活的显示用现有 touchDisplay 延寿；
     * 显示丢失时 clearDisplay（清 sessionId）后返回 false，绝不 ensureService、不重建。
     */
    synchronized boolean keepSurfaceAlive() {
        if (surfaceSessionId == null) return false;
        try {
            activeService();
            return surfaceSessionId != null;
        } catch (Exception lost) {
            return false;
        }
    }

    /** 统一 text 输入：插入光标处（不做 select-all 替换），经系统剪贴板粘贴。 */
    synchronized JSONObject surfaceText(String text) throws Exception {
        if (text == null || text.isEmpty() || text.length() > 1000) {
            throw new IllegalArgumentException("text 长度范围为 1..1000");
        }
        synchronized (clipboard) {
            copy(text);
            key(KeyEvent.KEYCODE_PASTE, 0, "PASTE");
        }
        return state("text").put("characters", text.length());
    }

    private byte[] requestPng(int maxWidth, int maxHeight) throws Exception {
        if (maxWidth < 160 || maxWidth > 1440 || maxHeight < 160 || maxHeight > 3200) {
            throw new IllegalArgumentException("截图尺寸范围为 160..1440 × 160..3200");
        }
        IShowerService service = activeService();
        byte[] png;
        try (ParcelFileDescriptor descriptor = service.requestScreenshot(displayId, maxWidth, maxHeight)) {
            if (descriptor == null) throw new IllegalStateException("Operit Shower 未返回截图");
            try (FileInputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[64 * 1024];
                for (int count; (count = input.read(buffer)) != -1; ) {
                    if (output.size() + count > MAX_SCREENSHOT_BYTES) {
                        throw new IllegalStateException("截图超过 12 MiB，请减小 maxWidth/maxHeight");
                    }
                    output.write(buffer, 0, count);
                }
                png = output.toByteArray();
            }
        }
        if (png.length < 24 || (png[0] & 0xff) != 0x89 || png[1] != 'P' || png[2] != 'N'
                || png[3] != 'G') throw new IllegalStateException("Operit Shower 截图不是有效 PNG");
        return png;
    }

    synchronized JSONObject tap(int x, int y) throws Exception {
        requireCoordinate(x, y);
        if (!activeService().tap(displayId, x, y)) {
            throw new IllegalStateException("虚拟屏点击注入失败");
        }
        return state("tap").put("x", x).put("y", y);
    }

    synchronized JSONObject swipe(int x1, int y1, int x2, int y2, long durationMs)
            throws Exception {
        requireCoordinate(x1, y1);
        requireCoordinate(x2, y2);
        if (durationMs < 1 || durationMs > 10_000) {
            throw new IllegalArgumentException("durationMs 范围为 1..10000");
        }
        Thread caller = Thread.currentThread();
        IShowerGesture gesture = new IShowerGesture.Stub() {
            @Override public boolean isCancelled() { return caller.isInterrupted(); }
        };
        if (!activeService().swipe(displayId, x1, y1, x2, y2, durationMs, gesture)) {
            if (caller.isInterrupted()) throw new InterruptedException("虚拟屏滑动已取消");
            throw new IllegalStateException("虚拟屏滑动注入失败");
        }
        return state("swipe").put("x1", x1).put("y1", y1).put("x2", x2)
                .put("y2", y2).put("durationMs", durationMs);
    }

    synchronized JSONObject key(int keyCode, int metaState, String keyName) throws Exception {
        synchronized (clipboard) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException("虚拟屏操作已取消");
            if (!activeService().injectKeyWithMeta(displayId, keyCode, metaState)) {
                throw new IllegalStateException("虚拟屏按键注入失败");
            }
            return state("key").put("key", keyName).put("metaState", metaState);
        }
    }

    synchronized JSONObject text(String text) throws Exception {
        if (text == null || text.length() > 1000) {
            throw new IllegalArgumentException("text 长度范围为 0..1000");
        }
        // The system clipboard is shared: don't let another chat overwrite it between write and paste.
        synchronized (clipboard) {
            activeService();
            if (!text.isEmpty()) copy(text);
            // Select-all replaces the entire field; empty text preserves the clipboard.
            key(KeyEvent.KEYCODE_A, KeyEvent.META_CTRL_ON, "A");
            key(text.isEmpty() ? KeyEvent.KEYCODE_DEL : KeyEvent.KEYCODE_PASTE, 0,
                    text.isEmpty() ? "DEL" : "PASTE");
        }
        return state("text").put("characters", text.length());
    }

    synchronized JSONObject copy(String text) throws Exception {
        if (text == null || text.isEmpty() || text.length() > 1000) {
            throw new IllegalArgumentException("text 长度范围为 1..1000");
        }
        synchronized (clipboard) {
            activeService();
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException("复制已取消");
            clipboard.setPrimaryClip(ClipData.newPlainText("e-launcher", text));
        }
        return state("copy").put("characters", text.length());
    }

    synchronized JSONObject paste() throws Exception {
        // The focused target can paste even when Android denies this host clipboard read access.
        key(KeyEvent.KEYCODE_PASTE, 0, "PASTE");
        return state("paste");
    }

    synchronized JSONObject release() throws Exception {
        boolean hadDisplay = displayId != null;
        boolean released = false;
        String destroyError = "";
        if (hadDisplay) {
            try {
                IShowerService service = manager.aliveService();
                released = service != null && service.asBinder() == displayService
                        && service.destroyDisplay(displayId);
            } catch (Exception exception) {
                destroyError = exception.getClass().getSimpleName() + ": " + exception.getMessage();
            } finally {
                clearDisplay();
            }
        }
        JSONObject result = new JSONObject().put("ok", destroyError.isEmpty())
                .put("action", "release").put("released", released);
        if (!destroyError.isEmpty()) result.put("destroyWarning", destroyError);
        return result;
    }

    private IShowerService activeService() throws android.os.RemoteException {
        IShowerService service = manager.aliveService();
        if (displayId == null || service == null || service.asBinder() != displayService
                || !service.touchDisplay(displayId)) {
            clearDisplay();
            throw new IllegalStateException("本聊天的虚拟屏尚未创建、已空闲超时回收或 Shower 已断开；调用 create 重新创建");
        }
        return service;
    }

    private void requireCoordinate(int x, int y) throws android.os.RemoteException {
        int[] size = displaySize();
        if (size == null) throw new IllegalStateException("虚拟屏尚未创建；先调用 create");
        if (x < 0 || y < 0 || x >= size[0] || y >= size[1]) {
            throw new IllegalArgumentException("坐标超出虚拟屏 " + size[0] + "x" + size[1]);
        }
    }

    private JSONObject state(String action) throws Exception {
        int[] size = displaySize();
        return new JSONObject().put("ok", true).put("action", action).put("displayId", displayId)
                .put("width", size == null ? 0 : size[0]).put("height", size == null ? 0 : size[1]).put("dpi", dpi)
                .put("idleTimeoutMs", 300_000);
    }

    private void clearDisplay() {
        preview = null;
        manualControl = false;
        userControl = false;
        userDirty = false;
        surfaceSessionId = null;
        launchedPackages.clear();
        notifyAll();
        displayId = null;
        width = 0;
        height = 0;
        dpi = 0;
        displayService = null;
        clientToken = null;
    }

    private static int align(int value) {
        return (value + 15) / 16 * 16;
    }

    private static void validateDisplay(int width, int height, int dpi, int bitrateKbps) {
        if (width < 320 || width > 4096 || height < 320 || height > 4096
                || (long) width * height > 8_000_000L) {
            throw new IllegalArgumentException("虚拟屏尺寸范围为 320..4096 × 320..4096，且不超过 800 万像素");
        }
        if (dpi < 120 || dpi > 640) throw new IllegalArgumentException("dpi 范围为 120..640");
        if (bitrateKbps < 128 || bitrateKbps > 12_000) {
            throw new IllegalArgumentException("bitrateKbps 范围为 128..12000");
        }
    }
}
