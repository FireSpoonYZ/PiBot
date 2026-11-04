package com.ai.assistance.shower;

import android.annotation.SuppressLint;
import android.app.ActivityOptions;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.Surface;

import com.ai.assistance.shower.shell.FakeContext;
import com.ai.assistance.shower.shell.Workarounds;
import com.ai.assistance.shower.wrappers.ServiceManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.io.PrintWriter;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.Locale;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * Binder-only virtual-display server adapted from Operit Shower.
 *
 * The host UID is the only accepted Binder caller; each conversation owns a separate display.
 */
public final class Main {
    private static final String ACTION_BINDER_READY =
            "com.ai.assistance.operit.action.SHOWER_BINDER_READY";
    private static final String EXTRA_BINDER_CONTAINER = "binder_container";
    private static final String EXTRA_HANDOFF_TOKEN = "handoff_token";
    private static final int CODEC_SIZE_ALIGNMENT = 16;
    private static final int DEFAULT_BIT_RATE = 500_000;
    private static final long IDLE_TIMEOUT_MS = 15_000;
    private static final long DISPLAY_IDLE_TIMEOUT_MS = 300_000;
    private static final long DISPLAY_USER_ACTIVITY_INTERVAL_MS = 4_000;
    private static final Pattern PACKAGE_NAME = Pattern.compile(
            "[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+");
    private static final Pattern TOKEN = Pattern.compile("[a-f0-9-]{36}");

    private static final int FLAG_SUPPORTS_TOUCH = 1 << 6;
    private static final int FLAG_ROTATES_WITH_CONTENT = 1 << 7;
    private static final int FLAG_DESTROY_CONTENT_ON_REMOVAL = 1 << 8;
    private static final int FLAG_TRUSTED = 1 << 10;
    private static final int FLAG_OWN_DISPLAY_GROUP = 1 << 11;
    private static final int FLAG_ALWAYS_UNLOCKED = 1 << 12;
    private static final int FLAG_TOUCH_FEEDBACK_DISABLED = 1 << 13;
    private static final int FLAG_OWN_FOCUS = 1 << 14;
    private static final int FLAG_DEVICE_DISPLAY_GROUP = 1 << 15;

    private static final SimpleDateFormat LOG_TIME =
            new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);
    private static String targetPackage;
    private static String handoffToken;
    private static String logPath;
    private static PrintWriter fileLog;

    private final Context context;
    private final int allowedUid;
    private final Map<Integer, DisplaySession> displays = new ConcurrentHashMap<>();
    private volatile long lastClientActive = SystemClock.elapsedRealtime();

    public static void main(String... args) {
        if (args == null || args.length != 4 || !PACKAGE_NAME.matcher(args[0]).matches()
                || !TOKEN.matcher(args[2]).matches() || !safeLogPath(args[3])) {
            throw new IllegalArgumentException("Expected host package, UID, handoff token and owned log path");
        }
        targetPackage = args[0];
        handoffToken = args[2];
        logPath = args[3];
        int uid;
        try {
            uid = Integer.parseInt(args[1]);
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException("Invalid host UID", exception);
        }
        if (uid < 10_000) throw new IllegalArgumentException("Invalid host UID");

        prepareMainLooper();
        Workarounds.apply();
        new Main(FakeContext.get(), uid);
        logToFile("Server started for " + targetPackage + " uid=" + uid, null);
        try {
            Thread.sleep(Long.MAX_VALUE);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        }
    }

    private Main(Context context, int allowedUid) {
        this.context = context.getApplicationContext();
        this.allowedUid = allowedUid;
        IShowerService service = new IShowerService.Stub() {
            @Override public int ensureDisplay(int width, int height, int dpi, int bitrateKbps) {
                enforceCaller();
                markClientActive();
                return createVirtualDisplay(width, height, dpi,
                        bitrateKbps > 0 ? bitrateKbps * 1000 : DEFAULT_BIT_RATE);
            }

            @Override public boolean attachClient(int displayId, IShowerClient client) {
                enforceCaller();
                if (client == null) throw new IllegalArgumentException("Client token is required");
                return withDisplay(displayId, current -> {
                    current.attachClient(client.asBinder(), () -> releaseDisplay(displayId));
                    return true;
                });
            }

            @Override public boolean touchDisplay(int displayId) {
                enforceCaller();
                DisplaySession current = displays.get(displayId);
                if (displayId <= 0 || current == null) return false;
                synchronized (current) {
                    if (displays.get(displayId) != current) return false;
                    current.lastActive = SystemClock.elapsedRealtime();
                    markClientActive();
                    return true;
                }
            }

            @Override public boolean hasDisplay(int displayId) {
                enforceCaller();
                return displayId > 0 && displays.containsKey(displayId);
            }

            @Override public int[] getDisplaySize(int displayId) {
                enforceCaller();
                if (displayId <= 0 || !displays.containsKey(displayId)) return null;
                com.ai.assistance.shower.device.DisplayInfo info = ServiceManager.getDisplayManager().getDisplayInfo(displayId);
                if (info == null) return null;
                return new int[] {info.getSize().getWidth(), info.getSize().getHeight()};
            }

            @Override public boolean setPreviewSurface(int displayId, Surface surface, IShowerClient viewer) {
                enforceCaller();
                if (viewer == null) throw new IllegalArgumentException("Viewer token is required");
                return withDisplay(displayId, current -> current.setPreview(surface, viewer.asBinder()));
            }

            @Override public boolean injectTouch(int displayId, android.view.MotionEvent event) {
                enforceCaller();
                if (event == null) throw new IllegalArgumentException("Touch event is required");
                try {
                    int action = event.getActionMasked();
                    if (action != android.view.MotionEvent.ACTION_DOWN && action != android.view.MotionEvent.ACTION_UP
                            && action != android.view.MotionEvent.ACTION_MOVE && action != android.view.MotionEvent.ACTION_CANCEL
                            && action != android.view.MotionEvent.ACTION_POINTER_DOWN && action != android.view.MotionEvent.ACTION_POINTER_UP) {
                        throw new IllegalArgumentException("Unsupported touch action");
                    }
                    if (event.getPointerCount() > 10 || event.getActionIndex() >= event.getPointerCount()) {
                        throw new IllegalArgumentException("Invalid touch pointers");
                    }
                    return withDisplay(displayId, current -> {
                        for (int i = 0; i < event.getPointerCount(); i++) {
                            requireCoordinate(current, event.getX(i), event.getY(i));
                        }
                        return current.input.touch(event);
                    });
                } finally { event.recycle(); }
            }

            @Override public boolean destroyDisplay(int displayId) {
                enforceCaller();
                markClientActive();
                return releaseDisplay(displayId);
            }

            @Override public boolean launchApp(String packageName, int displayId) {
                enforceCaller();
                return withDisplay(displayId, current -> launchPackage(packageName, current));
            }

            @Override public boolean tap(int displayId, float x, float y) {
                enforceCaller();
                return withDisplay(displayId, current -> {
                    requireCoordinate(current, x, y);
                    return current.input.tap(x, y);
                });
            }

            @Override public boolean swipe(int displayId, float x1, float y1, float x2, float y2,
                    long durationMs, IShowerGesture gesture) {
                enforceCaller();
                if (durationMs < 1 || durationMs > 10_000) {
                    throw new IllegalArgumentException("Swipe duration is out of range");
                }
                if (gesture == null) throw new IllegalArgumentException("Gesture cancellation token is required");
                return withDisplay(displayId, current -> {
                    requireCoordinate(current, x1, y1);
                    requireCoordinate(current, x2, y2);
                    return current.input.swipe(x1, y1, x2, y2, durationMs, () -> {
                        try { return gesture.isCancelled(); }
                        catch (android.os.RemoteException exception) { return true; }
                    });
                });
            }

            @Override public boolean injectKeyWithMeta(int displayId, int keyCode, int metaState) {
                enforceCaller();
                if (keyCode < 0 || keyCode > 288) throw new IllegalArgumentException("Invalid key code");
                return withDisplay(displayId, current -> current.input.injectKeyWithMeta(keyCode, metaState));
            }

            @Override public ParcelFileDescriptor requestScreenshot(int displayId, int maxWidth,
                    int maxHeight) {
                enforceCaller();
                if (maxWidth < 160 || maxWidth > 1440 || maxHeight < 160 || maxHeight > 3200) {
                    throw new IllegalArgumentException("Screenshot bounds are out of range");
                }
                return withDisplay(displayId, current ->
                        screenshotPipe(DisplayCapture.captureDisplay(displayId, maxWidth, maxHeight)));
            }
        };
        sendBinderToApp(service);
        startIdleWatcher();
    }

    private void enforceCaller() {
        int caller = Binder.getCallingUid();
        if (caller != allowedUid) throw new SecurityException("Caller is not the authorized host app");
    }

    @SuppressLint("WrongConstant") // Later display flags are hidden on older compile-time APIs.
    private synchronized int createVirtualDisplay(int width, int height, int dpi, int bitRate) {
        int alignedWidth = align(width);
        int alignedHeight = align(height);
        if (width < 320 || width > 4096 || height < 320 || height > 4096
                || (long) alignedWidth * alignedHeight > 8_000_000L
                || dpi < 120 || dpi > 640 || bitRate < 128_000 || bitRate > 12_000_000) {
            throw new IllegalArgumentException("Virtual display configuration is out of range");
        }
        markClientActive();
        MediaCodec encoder = null;
        Surface surface = null;
        VirtualDisplay virtualDisplay = null;
        try {
            MediaFormat format = MediaFormat.createVideoFormat("video/avc", alignedWidth, alignedHeight);
            format.setInteger(MediaFormat.KEY_COLOR_FORMAT,
                    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
            format.setInteger(MediaFormat.KEY_BIT_RATE, bitRate);
            format.setInteger(MediaFormat.KEY_FRAME_RATE, 30);
            format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
            encoder = MediaCodec.createEncoderByType("video/avc");
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            surface = encoder.createInputSurface();
            encoder.start();

            int flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC
                    | DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION
                    | DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
                    | FLAG_SUPPORTS_TOUCH | FLAG_ROTATES_WITH_CONTENT
                    | FLAG_DESTROY_CONTENT_ON_REMOVAL;
            if (Build.VERSION.SDK_INT >= 33) {
                flags |= FLAG_TRUSTED | FLAG_OWN_DISPLAY_GROUP | FLAG_ALWAYS_UNLOCKED
                        | FLAG_TOUCH_FEEDBACK_DISABLED;
            }
            if (Build.VERSION.SDK_INT >= 34) flags |= FLAG_OWN_FOCUS | FLAG_DEVICE_DISPLAY_GROUP;
            java.lang.reflect.Constructor<DisplayManager> constructor =
                    DisplayManager.class.getDeclaredConstructor(Context.class);
            constructor.setAccessible(true);
            DisplayManager manager = constructor.newInstance(FakeContext.get());
            virtualDisplay = manager.createVirtualDisplay("ShowerVirtualDisplay", alignedWidth,
                    alignedHeight, dpi, surface, flags);
            if (virtualDisplay == null || virtualDisplay.getDisplay() == null
                    || virtualDisplay.getDisplay().getDisplayId() <= 0) {
                throw new IllegalStateException("Android did not create the virtual display");
            }
            int id = virtualDisplay.getDisplay().getDisplayId();
            try {
                ServiceManager.getWindowManager().setDisplayImePolicy(id,
                        com.ai.assistance.shower.wrappers.WindowManager.DISPLAY_IME_POLICY_LOCAL);
            } catch (RuntimeException exception) {
                logToFile("Unable to set local IME policy: " + exception, exception);
            }
            displays.put(id, new DisplaySession(id, alignedWidth, alignedHeight, dpi, virtualDisplay,
                    encoder, surface, new InputController(id)));
            logToFile("Created virtual display " + id + " " + alignedWidth + "x" + alignedHeight,
                    null);
            return id;
        } catch (Throwable throwable) {
            if (virtualDisplay != null) virtualDisplay.release();
            if (encoder != null) try {
                encoder.stop();
            } catch (Exception ignored) { }
            if (encoder != null) encoder.release();
            if (surface != null) surface.release();
            logToFile("Unable to create virtual display", throwable);
            throw new IllegalStateException("Unable to create virtual display: " + throwable, throwable);
        }
    }

    private boolean releaseDisplay(int displayId) {
        DisplaySession current = displays.get(displayId);
        if (current == null) return false;
        synchronized (current) {
            synchronized (this) {
                if (!displays.remove(displayId, current)) return false;
                markClientActive();
            }
            try {
                current.release();
            } finally {
                // Start the server's 15-second idle period after the last display is released.
                markClientActive();
            }
            return true;
        }
    }

    private <T> T withDisplay(int displayId, Function<DisplaySession, T> action) {
        DisplaySession current = displays.get(displayId);
        if (displayId <= 0 || current == null) {
            throw new IllegalStateException("Virtual display expired or is not active; call create");
        }
        synchronized (current) {
            if (displays.get(displayId) != current) {
                throw new IllegalStateException("Virtual display expired or is not active; call create");
            }
            current.lastActive = SystemClock.elapsedRealtime();
            markClientActive();
            try {
                return action.apply(current);
            } finally {
                current.lastActive = SystemClock.elapsedRealtime();
                markClientActive();
            }
        }
    }

    private static void requireCoordinate(DisplaySession display, float x, float y) {
        com.ai.assistance.shower.device.DisplayInfo info = ServiceManager.getDisplayManager().getDisplayInfo(display.id);
        if (info == null || !Float.isFinite(x) || !Float.isFinite(y) || x < 0 || y < 0
                || x >= info.getSize().getWidth() || y >= info.getSize().getHeight()) {
            throw new IllegalArgumentException("Coordinate is outside the virtual display");
        }
    }

    private synchronized boolean launchPackage(String packageName, DisplaySession display) {
        if (packageName == null || !PACKAGE_NAME.matcher(packageName).matches()) {
            throw new IllegalArgumentException("Invalid package name");
        }
        for (DisplaySession other : displays.values()) {
            if (other != display && other.packages.contains(packageName)) {
                throw new IllegalStateException("应用已被其他聊天的虚拟屏占用；请先释放那块屏幕，再启动此应用");
            }
        }
        PackageManager packages = context.getPackageManager();
        Intent intent = packages.getLaunchIntentForPackage(packageName);
        if (intent == null) return false;
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ActivityOptions launchOptions = ActivityOptions.makeBasic();
        launchOptions.setLaunchDisplayId(display.id);
        int result = ServiceManager.getActivityManager().startActivity(intent,
                launchOptions.toBundle());
        if (result >= 0) display.packages.add(packageName);
        return result >= 0;
    }

    private static ParcelFileDescriptor screenshotPipe(byte[] png) {
        try {
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            Thread writer = new Thread(() -> {
                try (FileOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                    output.write(png);
                } catch (IOException exception) {
                    logToFile("Screenshot pipe failed: " + exception, exception);
                }
            }, "ShowerScreenshotWriter");
            writer.setDaemon(true);
            writer.start();
            return pipe[0];
        } catch (IOException exception) {
            throw new IllegalStateException("Unable to create screenshot pipe", exception);
        }
    }

    private void startIdleWatcher() {
        Thread watcher = new Thread(() -> {
            for (;;) {
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException exception) {
                    return;
                }
                for (DisplaySession current : displays.values()) {
                    // The same lock covers input/capture, so an in-flight operation cannot expire.
                    synchronized (current) {
                        if (displays.get(current.id) != current) continue;
                        long now = SystemClock.elapsedRealtime();
                        if (now - current.lastActive >= DISPLAY_IDLE_TIMEOUT_MS) {
                            logToFile("Virtual display " + current.id + " idle for 300000ms; releasing", null);
                            try { releaseDisplay(current.id); }
                            catch (Exception exception) { logToFile("Idle display release failed", exception); }
                        } else if (Build.VERSION.SDK_INT >= 33 && now >= current.nextUserActivityAt) {
                            // Only API 33+ displays request independent groups; run as shell, not a host Binder caller.
                            current.nextUserActivityAt = now + DISPLAY_USER_ACTIVITY_INTERVAL_MS;
                            try {
                                ServiceManager.getPowerManager().userActivity(current.id);
                                current.userActivityFailed = false;
                            } catch (IllegalStateException exception) {
                                if (!current.userActivityFailed) {
                                    logToFile("Virtual display " + current.id + " userActivity failed: "
                                            + exception, exception);
                                }
                                current.userActivityFailed = true;
                            }
                        }
                    }
                }
                synchronized (Main.this) {
                    if (displays.isEmpty() && SystemClock.elapsedRealtime() - lastClientActive >= IDLE_TIMEOUT_MS) {
                        logToFile("No virtual display is active; exiting", null);
                        System.exit(0);
                    }
                }
            }
        }, "ShowerIdleWatcher");
        watcher.setDaemon(true);
        watcher.start();
    }

    private void markClientActive() {
        lastClientActive = SystemClock.elapsedRealtime();
    }

    private void sendBinderToApp(IShowerService service) {
        Intent intent = new Intent(ACTION_BINDER_READY).setPackage(targetPackage)
                .addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES)
                .putExtra(EXTRA_BINDER_CONTAINER, new ShowerBinderContainer(service.asBinder()))
                .putExtra(EXTRA_HANDOFF_TOKEN, handoffToken);
        if (!sendBinderReadyViaActivityManager(intent)) {
            throw new IllegalStateException("Unable to hand Shower Binder to host app");
        }
    }

    private static boolean sendBinderReadyViaActivityManager(Intent intent) {
        try {
            Class<?> serviceManager = Class.forName("android.os.ServiceManager");
            IBinder activityBinder = (IBinder) serviceManager
                    .getDeclaredMethod("getService", String.class).invoke(null, "activity");
            Object activityManager = null;
            for (String stub : new String[] {"android.app.IActivityManager$Stub",
                    "android.app.ActivityManagerNative"}) {
                try {
                    Class<?> type = Class.forName(stub);
                    activityManager = type.getDeclaredMethod("asInterface", IBinder.class)
                            .invoke(null, activityBinder);
                    if (activityManager != null) break;
                } catch (Throwable ignored) { }
            }
            if (activityManager == null) return false;
            ArrayList<Method> candidates = new ArrayList<>();
            for (Method method : activityManager.getClass().getMethods()) {
                if (!"broadcastIntent".equals(method.getName())) continue;
                for (Class<?> type : method.getParameterTypes()) if (Intent.class.isAssignableFrom(type)) {
                    candidates.add(method);
                    break;
                }
            }
            Collections.sort(candidates, Comparator.comparingInt(Method::getParameterCount).reversed());
            for (Method method : candidates) try {
                method.setAccessible(true);
                method.invoke(activityManager, broadcastArguments(method.getParameterTypes(), intent));
                return true;
            } catch (InvocationTargetException exception) {
                logToFile("broadcastIntent failed: " + exception.getCause(), exception.getCause());
            } catch (Throwable exception) {
                logToFile("broadcastIntent unavailable: " + exception, exception);
            }
            return false;
        } catch (Throwable exception) {
            logToFile("Unable to obtain ActivityManager for Binder handoff: " + exception, exception);
            return false;
        }
    }

    private static Object[] broadcastArguments(Class<?>[] types, Intent intent) {
        Object[] args = new Object[types.length];
        int intentIndex = -1;
        for (int index = 0; index < types.length; index++) if (Intent.class.isAssignableFrom(types[index])) {
            intentIndex = index;
            break;
        }
        int integerIndex = 0;
        boolean callingPackageSet = false;
        for (int index = 0; index < types.length; index++) {
            Class<?> type = types[index];
            if (Intent.class.isAssignableFrom(type)) args[index] = intent;
            else if (type == String.class) {
                if (!callingPackageSet && index < intentIndex) {
                    args[index] = FakeContext.PACKAGE_NAME;
                    callingPackageSet = true;
                }
            } else if (type == int.class) {
                args[index] = integerIndex == 1 ? -1 : integerIndex >= 2 ? -2 : 0;
                integerIndex++;
            } else if (type == boolean.class) args[index] = false;
            else if (type == long.class) args[index] = 0L;
            else if (type == float.class) args[index] = 0f;
            else if (type == double.class) args[index] = 0d;
            else if (type == byte.class) args[index] = (byte) 0;
            else if (type == short.class) args[index] = (short) 0;
            else if (type == char.class) args[index] = (char) 0;
        }
        return args;
    }

    private static void prepareMainLooper() {
        if (Looper.myLooper() == null) Looper.prepare();
        synchronized (Looper.class) {
            try {
                Field field = Looper.class.getDeclaredField("sMainLooper");
                field.setAccessible(true);
                field.set(null, Looper.myLooper());
            } catch (ReflectiveOperationException exception) {
                throw new IllegalStateException("Unable to prepare main Looper", exception);
            }
        }
    }

    private static int align(int value) {
        return (value + CODEC_SIZE_ALIGNMENT - 1) / CODEC_SIZE_ALIGNMENT * CODEC_SIZE_ALIGNMENT;
    }

    private static boolean safeLogPath(String path) {
        return path != null && path.matches(
                "/data/local/tmp/e-launcher-shower-[0-9]+/server\\.log");
    }

    static synchronized void logToFile(String message, Throwable throwable) {
        try {
            if (fileLog == null && logPath != null) {
                File file = new File(logPath);
                fileLog = new PrintWriter(new FileWriter(file, true), true);
            }
            String line = LOG_TIME.format(new Date()) + " " + message;
            if (fileLog != null) {
                fileLog.println(line);
                if (throwable != null) throwable.printStackTrace(fileLog);
            } else {
                System.err.println(line);
                if (throwable != null) throwable.printStackTrace(System.err);
            }
        } catch (IOException ignored) { }
    }

    private static final class DisplaySession {
        final int id;
        final int width;
        final int height;
        final int dpi;
        final VirtualDisplay virtualDisplay;
        final MediaCodec encoder;
        final Surface surface;
        final InputController input;
        final Thread drain;
        final Set<String> packages = new HashSet<>(); // Guarded by Main's monitor, including launch conflict checks.
        IBinder clientBinder;
        IBinder.DeathRecipient clientDeath;
        IBinder viewerBinder;
        IBinder.DeathRecipient viewerDeath;
        Surface previewSurface;
        volatile boolean running = true;
        long lastActive = SystemClock.elapsedRealtime();
        long nextUserActivityAt; // First activity is due on the next watcher tick, without renewing the resource lease.
        boolean userActivityFailed;

        DisplaySession(int id, int width, int height, int dpi, VirtualDisplay virtualDisplay,
                MediaCodec encoder, Surface surface, InputController input) {
            this.id = id;
            this.width = width;
            this.height = height;
            this.dpi = dpi;
            this.virtualDisplay = virtualDisplay;
            this.encoder = encoder;
            this.surface = surface;
            this.input = input;
            drain = new Thread(this::drainEncoder, "ShowerEncoder-" + id);
            drain.setDaemon(true);
            drain.start();
        }

        synchronized void attachClient(IBinder binder, Runnable died) {
            if (clientBinder != null && clientDeath != null) {
                clientBinder.unlinkToDeath(clientDeath, 0);
            }
            clientBinder = binder;
            clientDeath = () -> {
                logToFile("Host Binder died for virtual display " + id, null);
                died.run();
            };
            try {
                binder.linkToDeath(clientDeath, 0);
            } catch (android.os.RemoteException exception) {
                clientBinder = null;
                clientDeath = null;
                throw new IllegalStateException("Host Binder is already dead", exception);
            }
        }

        // Same-device rendering uses the compositor directly; no encode/decode or frame copies.
        synchronized boolean setPreview(Surface next, IBinder viewer) {
            if (next == null) {
                if (viewerBinder != viewer) return false; // A stale Activity must not detach its replacement.
                restoreSurface();
                return true;
            }
            if (!next.isValid()) { next.release(); throw new IllegalArgumentException("Invalid preview surface"); }
            IBinder.DeathRecipient died = () -> {
                synchronized (DisplaySession.this) {
                    if (viewerBinder == viewer && running) restoreSurface();
                }
            };
            try {
                viewer.linkToDeath(died, 0);
                input.cancelTouch();
                virtualDisplay.setSurface(next);
            } catch (Exception exception) {
                viewer.unlinkToDeath(died, 0);
                next.release();
                throw new IllegalStateException("Unable to attach preview", exception);
            }
            clearViewer();
            previewSurface = next;
            viewerBinder = viewer;
            viewerDeath = died;
            return true;
        }

        private void restoreSurface() {
            input.cancelTouch();
            virtualDisplay.setSurface(surface);
            clearViewer();
            lastActive = SystemClock.elapsedRealtime();
        }

        private void clearViewer() {
            if (viewerBinder != null && viewerDeath != null) viewerBinder.unlinkToDeath(viewerDeath, 0);
            viewerBinder = null;
            viewerDeath = null;
            if (previewSurface != null) { previewSurface.release(); previewSurface = null; }
        }

        void drainEncoder() {
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            while (running) try {
                int index = encoder.dequeueOutputBuffer(info, 10_000);
                if (index >= 0) encoder.releaseOutputBuffer(index, false);
            } catch (IllegalStateException exception) {
                if (running) logToFile("Encoder drain failed: " + exception, exception);
                return;
            }
        }

        synchronized void release() {
            running = false;
            input.cancelTouch();
            clearViewer();
            if (clientBinder != null && clientDeath != null) {
                clientBinder.unlinkToDeath(clientDeath, 0);
                clientBinder = null;
                clientDeath = null;
            }
            try {
                encoder.signalEndOfInputStream();
            } catch (Exception ignored) { }
            try {
                drain.join(1000);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
            }
            try {
                virtualDisplay.release();
            } catch (Exception ignored) { }
            try {
                encoder.stop();
            } catch (Exception ignored) { }
            encoder.release();
            surface.release();
            logToFile("Released virtual display " + id, null);
        }
    }
}
