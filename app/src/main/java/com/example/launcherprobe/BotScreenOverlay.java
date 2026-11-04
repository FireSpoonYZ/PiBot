package com.example.launcherprobe;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.graphics.Outline;
import android.graphics.SurfaceTexture;
import android.os.Binder;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.webkit.WebView;
import android.widget.FrameLayout;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;
import java.util.function.Supplier;

/**
 * :tauri_ui 进程的 Bot 屏幕覆盖层：原生 TextureView 贴在 WebView 中 React 占位元素的位置上，
 * 画面经 {@link BotScreenService} 由 Shower 直接写入本 Surface（零拷贝、无编解码）。
 * 未接管时触摸穿透给 WebView；接管后触摸映射到虚拟屏坐标并转发。
 * 只观看已有屏幕：不创建屏幕、不启动 Host/Shizuku/Shower。
 */
final class BotScreenOverlay implements TextureView.SurfaceTextureListener {
    private static final long POLL_MS = 1000;

    private final Activity activity;
    private final Supplier<WebView> webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "bot-screen-overlay");
        thread.setDaemon(true);
        return thread;
    });
    /** 本 UI 的观看身份：进程死亡时默认进程自动解绑预览。 */
    private final IBinder viewer = new Binder();

    // ---- 主线程状态 ----
    private FrameLayout container;
    private TextureView texture;
    private ScheduledFuture<?> polling;
    private boolean bound;
    private boolean paused;
    private MotionEvent lastTouch;
    private float cornerRadiusPx;
    /** 每次 open 递增；前端用它丢弃过期会话的 layout/close，避免旧页面关掉新画面。 */
    private int sessionId;

    // ---- 跨线程状态 ----
    private volatile String botId;
    private volatile int generation;
    private volatile IBotScreen service;
    private volatile SurfaceTexture output;
    private volatile boolean destroyed;
    private volatile String phase = "idle";
    private volatile String message = "";
    private volatile boolean live;
    private volatile boolean userControl;
    private volatile int displayWidth = 1;
    private volatile int displayHeight = 1;

    // ---- worker 线程写入 ----
    private Surface surface;
    private volatile boolean attached;
    private boolean seenDisplay;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            service = IBotScreen.Stub.asInterface(binder);
            schedulePoll(0);
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            service = null;
            runOnWorker(() -> {
                releaseLocal();
                phase = "connecting";
            });
        }
    };

    BotScreenOverlay(Activity activity, Supplier<WebView> webView) {
        this.activity = activity;
        this.webView = webView;
    }

    // ---------- 主线程 API ----------

    void open(String nextBotId) {
        if (destroyed) throw new IllegalStateException("界面已结束");
        if (nextBotId.equals(botId) && container != null) {
            sessionId++;
            return;
        }
        close();
        sessionId++;
        botId = nextBotId;
        generation++;
        seenOnWorker(false);
        phase = "connecting";
        message = "";
        ensureViews();
        if (!bound) {
            bound = activity.bindService(new Intent(activity, BotScreenService.class), connection,
                    Context.BIND_AUTO_CREATE);
            if (!bound) {
                phase = "unavailable";
                message = "Bot 屏幕服务不可用";
            }
        }
        if (!paused) startPolling();
    }

    /** rect 为 CSS 像素（相对 WebView 视口），dpr 为 devicePixelRatio。 */
    void layout(double x, double y, double width, double height, double dpr, double radius, boolean visible) {
        if (container == null) return;
        WebView view = webView.get();
        ViewGroup content = activity.findViewById(android.R.id.content);
        if (view == null || content == null || !visible || width < 1 || height < 1) {
            container.setVisibility(View.INVISIBLE);
            cancelGesture();
            return;
        }
        int[] webLocation = new int[2];
        int[] contentLocation = new int[2];
        view.getLocationInWindow(webLocation);
        content.getLocationInWindow(contentLocation);
        FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) container.getLayoutParams();
        params.width = Math.max(1, (int) Math.round(width * dpr));
        params.height = Math.max(1, (int) Math.round(height * dpr));
        params.leftMargin = webLocation[0] - contentLocation[0] - content.getPaddingLeft() + (int) Math.round(x * dpr);
        params.topMargin = webLocation[1] - contentLocation[1] - content.getPaddingTop() + (int) Math.round(y * dpr);
        params.gravity = Gravity.TOP | Gravity.START;
        container.setLayoutParams(params);
        cornerRadiusPx = (float) Math.max(0, radius * dpr);
        container.invalidateOutline();
        fitTexture(params.width, params.height);
        container.setVisibility(View.VISIBLE);
    }

    int session() {
        return sessionId;
    }

    boolean isSession(int candidate) {
        return botId != null && candidate == sessionId;
    }

    JSONObject status() {
        JSONObject result = new JSONObject();
        try {
            result.put("session", sessionId);
            result.put("phase", phase);
            result.put("live", live);
            result.put("userControl", userControl);
            result.put("width", displayWidth);
            result.put("height", displayHeight);
            result.put("platform", "android-shower");
            if (!message.isEmpty()) result.put("message", message);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
        return result;
    }

    /** 回调在 worker 线程：先中断在途屏幕动作，确认后才接受用户输入。 */
    void takeover(BiConsumer<JSONObject, Throwable> done) {
        int run = generation;
        if (!runOnWorker(() -> {
            try {
                IBotScreen current = service;
                if (run != generation || current == null || !attached || !live) {
                    throw new IllegalStateException("画面未连接，无法接管");
                }
                current.takeover(viewer);
                if (run == generation) userControl = true;
                done.accept(status(), null);
            } catch (Throwable failure) {
                done.accept(null, failure);
            }
        })) done.accept(null, new IllegalStateException("界面已结束"));
    }

    void close() {
        cancelGesture();
        stopPolling();
        generation++;
        botId = null;
        phase = "idle";
        live = false;
        userControl = false;
        if (container != null) {
            ViewGroup parent = (ViewGroup) container.getParent();
            if (parent != null) parent.removeView(container); // SurfaceTexture 随之销毁并解绑预览。
            container = null;
            texture = null;
        }
        runOnWorker(this::detachRemote);
        if (bound) {
            bound = false;
            try { activity.unbindService(connection); }
            catch (IllegalArgumentException ignored) { }
            service = null;
        }
    }

    /** Activity 暂停：解绑画面恢复原 Surface；接管随之结束。 */
    void pause() {
        paused = true;
        cancelGesture();
        stopPolling();
        live = false;
        userControl = false;
        if (texture != null) texture.setAlpha(0f);
        runOnWorker(this::detachRemote);
    }

    void resume() {
        paused = false;
        if (botId != null && container != null) startPolling();
    }

    void destroy() {
        destroyed = true;
        close();
        runOnWorker(worker::shutdown);
    }

    /** worker 已关闭时返回 false，调用方自行收尾；绝不在主线程抛出。 */
    private boolean runOnWorker(Runnable action) {
        try {
            worker.execute(action);
            return true;
        } catch (java.util.concurrent.RejectedExecutionException closed) {
            return false;
        }
    }

    // ---------- 视图 ----------

    private void ensureViews() {
        if (container != null) return;
        ViewGroup content = activity.findViewById(android.R.id.content);
        if (content == null) throw new IllegalStateException("界面未就绪");
        container = new FrameLayout(activity);
        container.setVisibility(View.INVISIBLE);
        container.setClipToOutline(true);
        container.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View view, Outline outline) {
                outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), cornerRadiusPx);
            }
        });
        texture = new TextureView(activity);
        texture.setAlpha(0f);
        texture.setContentDescription("Bot 屏幕画面，接管后可触摸操作");
        texture.setSurfaceTextureListener(this);
        texture.setOnTouchListener((view, event) -> handleTouch(event));
        container.addView(texture, new FrameLayout.LayoutParams(1, 1, Gravity.CENTER));
        content.addView(container, new FrameLayout.LayoutParams(1, 1));
    }

    private void fitTexture(int boxWidth, int boxHeight) {
        if (texture == null) return;
        float scale = Math.min((float) boxWidth / Math.max(1, displayWidth), (float) boxHeight / Math.max(1, displayHeight));
        FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) texture.getLayoutParams();
        int width = Math.max(1, Math.round(displayWidth * scale));
        int height = Math.max(1, Math.round(displayHeight * scale));
        if (params.width == width && params.height == height) return;
        params.width = width;
        params.height = height;
        params.gravity = Gravity.CENTER;
        texture.setLayoutParams(params);
    }

    private void refit() {
        if (container == null) return;
        ViewGroup.LayoutParams params = container.getLayoutParams();
        if (params != null) fitTexture(params.width, params.height);
    }

    // ---------- 触摸 ----------

    private boolean handleTouch(MotionEvent event) {
        if (!userControl || !live) return false; // 未接管：穿透给下面的 WebView。
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN && texture.getParent() != null) {
            texture.getParent().requestDisallowInterceptTouchEvent(true);
        }
        MotionEvent mapped = mapTouch(event, texture.getWidth(), texture.getHeight(),
                displayWidth, displayHeight);
        if (lastTouch != null) lastTouch.recycle();
        lastTouch = MotionEvent.obtain(mapped);
        sendTouch(mapped);
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            lastTouch.recycle();
            lastTouch = null;
            if (texture.getParent() != null) texture.getParent().requestDisallowInterceptTouchEvent(false);
            if (action == MotionEvent.ACTION_UP) texture.performClick();
        }
        return true;
    }

    private static MotionEvent mapTouch(MotionEvent event, int viewWidth, int viewHeight, int width, int height) {
        int count = event.getPointerCount();
        MotionEvent.PointerProperties[] properties = new MotionEvent.PointerProperties[count];
        MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[count];
        for (int i = 0; i < count; i++) {
            properties[i] = new MotionEvent.PointerProperties(); event.getPointerProperties(i, properties[i]);
            coords[i] = new MotionEvent.PointerCoords(); event.getPointerCoords(i, coords[i]);
            coords[i].x = Math.max(0, Math.min(width - 1, coords[i].x * width / Math.max(1, viewWidth)));
            coords[i].y = Math.max(0, Math.min(height - 1, coords[i].y * height / Math.max(1, viewHeight)));
        }
        return MotionEvent.obtain(event.getDownTime(), event.getEventTime(), event.getAction(), count,
                properties, coords, event.getMetaState(), event.getButtonState(), 1, 1, 0,
                event.getEdgeFlags(), InputDevice.SOURCE_TOUCHSCREEN, event.getFlags());
    }

    private void sendTouch(MotionEvent event) {
        int run = generation;
        try {
            worker.execute(() -> {
                try {
                    IBotScreen current = service;
                    if (run == generation && attached && current != null) current.touch(viewer, event);
                } catch (Exception ignored) {
                    // 画面状态由轮询反映；单个事件失败不打断手势。
                } finally {
                    event.recycle();
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException closed) {
            event.recycle();
        }
    }

    /** 隐藏、暂停或关闭时补一个 CANCEL，避免虚拟屏上残留按下的指针。 */
    private void cancelGesture() {
        if (lastTouch == null) return;
        lastTouch.setAction(MotionEvent.ACTION_CANCEL);
        sendTouch(lastTouch);
        lastTouch = null;
    }

    // ---------- 轮询（worker） ----------

    private void startPolling() {
        stopPolling();
        polling = worker.scheduleWithFixedDelay(this::poll, 0, POLL_MS, TimeUnit.MILLISECONDS);
    }

    private void stopPolling() {
        if (polling != null) polling.cancel(false);
        polling = null;
    }

    private void schedulePoll(long delayMs) {
        try {
            worker.schedule(this::poll, delayMs, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.RejectedExecutionException ignored) { }
    }

    private void poll() {
        String target = botId;
        int run = generation;
        IBotScreen current = service;
        if (target == null || paused || destroyed) return;
        if (current == null) {
            if (!"unavailable".equals(phase)) phase = "connecting";
            return;
        }
        try {
            if (attached) {
                if (!current.keepAlive(viewer)) {
                    releaseLocal();
                    publishEnded(run);
                }
                return;
            }
            JSONObject state = new JSONObject(current.status(target));
            if (run != generation) return;
            if (!state.optBoolean("exists")) {
                phase = seenDisplay ? "ended" : "none";
                message = "";
                return;
            }
            SurfaceTexture outputTexture = output;
            if (outputTexture == null) {
                phase = "connecting";
                return;
            }
            int initWidth = Math.max(1, state.optInt("width", 1));
            int initHeight = Math.max(1, state.optInt("height", 1));
            outputTexture.setDefaultBufferSize(initWidth, initHeight);
            surface = new Surface(outputTexture);
            live = false;
            userControl = false;
            phase = "connecting";
            message = "";
            attached = true;
            JSONObject attachedState = new JSONObject(current.attach(target, surface, viewer));
            if (run != generation) {
                current.detach(viewer);
                releaseLocal();
                return;
            }
            int width = Math.max(1, attachedState.optInt("width", initWidth));
            int height = Math.max(1, attachedState.optInt("height", initHeight));
            if (width != initWidth || height != initHeight) {
                outputTexture.setDefaultBufferSize(width, height);
            }
            seenDisplay = true;
            displayWidth = width;
            displayHeight = height;
            main.post(this::refit);
        } catch (Exception failure) {
            releaseLocal();
            if (run != generation) return;
            phase = "error";
            String text = failure.getMessage();
            message = text == null || text.isEmpty() ? "画面连接失败，正在重试" : text;
        }
    }

    private void publishEnded(int run) {
        if (run != generation) return;
        live = false;
        userControl = false;
        phase = "ended";
        main.post(() -> { if (texture != null) texture.setAlpha(0f); });
    }

    private void seenOnWorker(boolean value) {
        runOnWorker(() -> seenDisplay = value);
    }

    /** worker：通知默认进程解绑并释放本地 Surface。 */
    private void detachRemote() {
        IBotScreen current = service;
        if (attached && current != null) {
            try { current.detach(viewer); }
            catch (Exception ignored) { }
        }
        releaseLocal();
    }

    private void releaseLocal() {
        attached = false;
        live = false;
        userControl = false;
        if (surface != null) {
            surface.release();
            surface = null;
        }
    }

    // ---------- SurfaceTexture ----------

    @Override public void onSurfaceTextureAvailable(SurfaceTexture surfaceTexture, int width, int height) {
        output = surfaceTexture;
        schedulePoll(0);
    }

    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture surfaceTexture, int width, int height) {
        surfaceTexture.setDefaultBufferSize(displayWidth, displayHeight);
    }

    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture surfaceTexture) {
        if (output == surfaceTexture) output = null;
        try {
            worker.execute(() -> {
                detachRemote();
                surfaceTexture.release();
            });
        } catch (java.util.concurrent.RejectedExecutionException closed) {
            surfaceTexture.release();
        }
        return false;
    }

    @Override public void onSurfaceTextureUpdated(SurfaceTexture surfaceTexture) {
        if (live || !attached || botId == null || paused) return;
        live = true;
        phase = "live";
        if (texture != null) texture.setAlpha(1f);
    }
}
