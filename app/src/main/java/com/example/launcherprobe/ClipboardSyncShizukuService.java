package com.example.launcherprobe;

import android.annotation.SuppressLint;
import android.app.AppOpsManager;
import android.app.KeyguardManager;
import android.content.AttributionSource;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.pm.PackageManager;
import android.os.Binder;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Process;
import android.os.RemoteException;
import android.os.UserManager;

import java.lang.reflect.Field;
import java.util.Objects;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import java.util.function.IntSupplier;

/**
 * Dedicated, narrowly typed Shizuku UserService for Android background clipboard observation.
 *
 * <p>Security boundaries:
 * <ul>
 *   <li>Every IPC method validates {@code Binder.getCallingUid() == appUid} (except
 *       {@link #destroy()}, which also allows {@code 0} / {@link Process#SHELL_UID} as required
 *       by Shizuku teardown).</li>
 *   <li>Refuses cross-profile observation ({@code appUserId != serviceUserId}), locked user/screen
 *       reads, and environments where shell lacks {@code READ_CLIPBOARD_IN_BACKGROUND} or where
 *       AppOps/OEM policy denies background clipboard access. Never escalates privileges, executes
 *       shell/ADB commands, touches files/URLs/packages, or writes to the clipboard.</li>
 *   <li>Shell attribution limitation: Shizuku constructs UserServices with the host app's package
 *       {@link Context}, whose {@code opPackageName} mismatches UID {@link Process#SHELL_UID} when
 *       calling {@link ClipboardManager}. This service first prefers the public SDK
 *       {@link Context#createPackageContext(String, int)} for {@code com.android.shell}; only if
 *       that fails or does not carry shell attribution does it fall back to a narrow
 *       {@link ShellAttributionContext} shim mirroring the project's existing Shower shell
 *       {@code FakeContext} ({@code ClipboardManager.mContext}). If hidden-API policy or OEM
 *       restrictions block both, {@link #startListening} cleanly returns {@code false}.</li>
 *   <li>Reuses {@link ClipboardSyncController#validateDescription(ClipDescription)} and
 *       {@link ClipboardSyncController#extractSendableText(ClipData)} so own incoming writes,
 *       Shower {@code "pibot"} clips, {@link ClipDescription#EXTRA_IS_SENSITIVE}, URIs/Intents,
 *       non-plain MIME types, and oversized text (&gt; 64 KiB UTF-8) never cross IPC or bounce.</li>
 * </ul>
 */
public final class ClipboardSyncShizukuService extends IClipboardSyncShizukuService.Stub {

    static final String SHELL_PACKAGE = "com.android.shell";
    static final String PERMISSION_READ_CLIPBOARD_IN_BACKGROUND =
            "android.permission.READ_CLIPBOARD_IN_BACKGROUND";
    private static final String OPSTR_READ_CLIPBOARD = "android:read_clipboard";
    static final int PER_USER_RANGE = 100_000;
    private static final long MAIN_OP_TIMEOUT_MS = 2_000L;

    interface ClipboardBackend {
        boolean addListener(ClipboardManager.OnPrimaryClipChangedListener listener);

        void removeListener(ClipboardManager.OnPrimaryClipChangedListener listener);

        ClipDescription getPrimaryClipDescription();

        ClipData getPrimaryClip();
    }

    private final int appUid;
    private final int serviceUid;
    private final IntSupplier callingUidSupplier;
    private final BooleanSupplier permissionChecker;
    private final BooleanSupplier appOpsAllowedChecker;
    private final BooleanSupplier userUnlockedChecker;
    private final BooleanSupplier deviceLockedChecker;
    private final ClipboardBackend clipboardBackend;
    private final Executor notifyExecutor;
    private final ExecutorService ownedExecutor;
    private final boolean exitOnDestroy;

    private final Object stateLock = new Object();
    private final AtomicBoolean notifyQueued = new AtomicBoolean();
    private volatile boolean listening;
    private IClipboardSyncShizukuCallback activeCallback;
    private IBinder activeCallbackBinder;
    private IBinder.DeathRecipient activeDeathRecipient;
    private ClipboardManager.OnPrimaryClipChangedListener activeOsListener;
    private long baselineTimestampMs;
    private long lastDeliveredTimestampMs;

    /** Standard Shizuku UserService constructor invoked by Shizuku server. */
    public ClipboardSyncShizukuService(Context context) {
        this(
                context.getApplicationInfo().uid,
                Process.myUid(),
                Binder::getCallingUid,
                () -> hasBackgroundClipboardPermission(context, Process.myUid()),
                () -> isReadClipboardAppOpAllowed(context, Process.myUid()),
                () -> isUserUnlocked(context),
                () -> isDeviceOrScreenLocked(context),
                new SystemClipboardBackend(context),
                null,
                true);
    }

    /** Package-private constructor for isolated Robolectric/unit tests. */
    ClipboardSyncShizukuService(int appUid,
                                int serviceUid,
                                IntSupplier callingUidSupplier,
                                BooleanSupplier permissionChecker,
                                BooleanSupplier appOpsAllowedChecker,
                                BooleanSupplier userUnlockedChecker,
                                BooleanSupplier deviceLockedChecker,
                                ClipboardBackend clipboardBackend,
                                Executor testNotifyExecutor,
                                boolean exitOnDestroy) {
        this.appUid = appUid;
        this.serviceUid = serviceUid;
        this.callingUidSupplier = Objects.requireNonNull(callingUidSupplier);
        this.permissionChecker = Objects.requireNonNull(permissionChecker);
        this.appOpsAllowedChecker = Objects.requireNonNull(appOpsAllowedChecker);
        this.userUnlockedChecker = Objects.requireNonNull(userUnlockedChecker);
        this.deviceLockedChecker = Objects.requireNonNull(deviceLockedChecker);
        this.clipboardBackend = Objects.requireNonNull(clipboardBackend);
        if (testNotifyExecutor != null) {
            this.notifyExecutor = testNotifyExecutor;
            this.ownedExecutor = null;
        } else {
            this.ownedExecutor = Executors.newSingleThreadExecutor(runnable -> {
                Thread thread = new Thread(runnable, "clipboard-shizuku-notify");
                thread.setDaemon(true);
                return thread;
            });
            this.notifyExecutor = this.ownedExecutor;
        }
        this.exitOnDestroy = exitOnDestroy;
    }

    static boolean isPrivilegedShizukuUid(int uid) {
        return uid == Process.SHELL_UID || uid == 0;
    }

    static boolean isSameUserProfile(int appUid, int serviceUid) {
        if (appUid < 0 || serviceUid < 0) {
            return false;
        }
        return (appUid / PER_USER_RANGE) == (serviceUid / PER_USER_RANGE);
    }

    @Override
    public boolean startListening(IClipboardSyncShizukuCallback callback) {
        enforceAppCaller();
        if (callback == null) {
            return false;
        }
        synchronized (stateLock) {
            stopListeningLocked();
            if (!isPrivilegedShizukuUid(serviceUid) || !isSameUserProfile(appUid, serviceUid)) {
                return false;
            }
            if (!permissionChecker.getAsBoolean() || !appOpsAllowedChecker.getAsBoolean()) {
                return false;
            }
            if (!userUnlockedChecker.getAsBoolean()) {
                return false;
            }
            IBinder callbackBinder = callback.asBinder();
            if (callbackBinder == null || !callbackBinder.isBinderAlive()) {
                return false;
            }
            ClipboardManager.OnPrimaryClipChangedListener listener = this::onOsPrimaryClipChanged;
            if (!clipboardBackend.addListener(listener)) {
                return false;
            }
            // Record pre-existing clip timestamp via metadata only (NEVER calls getPrimaryClip)
            // so clips already present before Link active-online can never be published.
            long baselineTs;
            try {
                ClipDescription currentDesc = clipboardBackend.getPrimaryClipDescription();
                baselineTs = currentDesc != null ? Math.max(0L, currentDesc.getTimestamp()) : 0L;
            } catch (SecurityException denied) {
                clipboardBackend.removeListener(listener);
                return false;
            } catch (RuntimeException ignored) {
                baselineTs = 0L;
            }
            IBinder.DeathRecipient deathRecipient = () -> {
                synchronized (stateLock) {
                    if (activeCallbackBinder == callbackBinder) {
                        stopListeningLocked();
                    }
                }
            };
            try {
                callbackBinder.linkToDeath(deathRecipient, 0);
            } catch (RemoteException dead) {
                clipboardBackend.removeListener(listener);
                return false;
            }
            activeCallback = callback;
            activeCallbackBinder = callbackBinder;
            activeDeathRecipient = deathRecipient;
            activeOsListener = listener;
            baselineTimestampMs = baselineTs;
            lastDeliveredTimestampMs = baselineTs;
            listening = true;
            return true;
        }
    }

    @Override
    public void stopListening() {
        enforceAppCaller();
        synchronized (stateLock) {
            stopListeningLocked();
        }
    }

    @Override
    public String readFilteredPlainText() {
        enforceAppCaller();
        IClipboardSyncShizukuCallback cb;
        long baseline;
        long lastDelivered;
        synchronized (stateLock) {
            if (!listening || activeCallback == null) {
                return null;
            }
            cb = activeCallback;
            baseline = baselineTimestampMs;
            lastDelivered = lastDeliveredTimestampMs;
        }
        if (!isPrivilegedShizukuUid(serviceUid)
                || !isSameUserProfile(appUid, serviceUid)
                || !userUnlockedChecker.getAsBoolean()
                || deviceLockedChecker.getAsBoolean()) {
            return null;
        }
        ClipDescription desc;
        try {
            desc = clipboardBackend.getPrimaryClipDescription();
        } catch (SecurityException denied) {
            notifyUnavailableAndStop(cb);
            return null;
        } catch (RuntimeException failure) {
            return null;
        }
        if (desc == null) {
            return null;
        }
        long descTs = desc.getTimestamp();
        if (isStaleTimestamp(descTs, baseline, lastDelivered)) {
            return null;
        }
        if (ClipboardSyncController.validateDescription(desc) != null) {
            return null;
        }
        ClipData clip;
        try {
            clip = clipboardBackend.getPrimaryClip();
        } catch (SecurityException denied) {
            notifyUnavailableAndStop(cb);
            return null;
        } catch (RuntimeException failure) {
            return null;
        }
        if (clip == null) {
            return null;
        }
        ClipDescription clipDesc = clip.getDescription();
        long clipTs = clipDesc != null ? clipDesc.getTimestamp() : 0L;
        if (isStaleTimestamp(clipTs, baseline, lastDelivered)) {
            return null;
        }
        ClipboardSyncController.ClipReadResult result = ClipboardSyncController.extractSendableText(clip);
        if (!result.ok || result.text == null || result.text.isEmpty()) {
            return null;
        }
        if (clipTs > 0L) {
            synchronized (stateLock) {
                if (listening && activeCallback == cb && clipTs > lastDeliveredTimestampMs) {
                    lastDeliveredTimestampMs = clipTs;
                }
            }
        }
        return result.text;
    }

    @Override
    public void destroy() {
        int caller = callingUidSupplier.getAsInt();
        if (caller != appUid && caller != 0 && caller != Process.SHELL_UID) {
            throw new SecurityException("Caller cannot destroy service");
        }
        teardownInternal();
        if (exitOnDestroy) {
            System.exit(0);
        }
    }

    private void onOsPrimaryClipChanged() {
        if (!listening) {
            return;
        }
        if (!notifyQueued.compareAndSet(false, true)) {
            return;
        }
        try {
            notifyExecutor.execute(this::dispatchClipChangedOnWorker);
        } catch (RuntimeException rejected) {
            notifyQueued.set(false);
        }
    }

    private void dispatchClipChangedOnWorker() {
        notifyQueued.set(false);
        IClipboardSyncShizukuCallback cb;
        long baseline;
        long lastDelivered;
        synchronized (stateLock) {
            if (!listening || activeCallback == null) {
                return;
            }
            cb = activeCallback;
            baseline = baselineTimestampMs;
            lastDelivered = lastDeliveredTimestampMs;
        }
        if (!userUnlockedChecker.getAsBoolean() || deviceLockedChecker.getAsBoolean()) {
            return;
        }
        // Metadata pre-filter before crossing Binder IPC to the app process:
        // avoids waking the app for own incoming sync writes, Shower clips, sensitive clips,
        // non-plain MIME types, or stale pre-online timestamps.
        try {
            ClipDescription desc = clipboardBackend.getPrimaryClipDescription();
            if (desc == null) {
                return;
            }
            long ts = desc.getTimestamp();
            if (isStaleTimestamp(ts, baseline, lastDelivered)) {
                return;
            }
            if (ClipboardSyncController.validateDescription(desc) != null) {
                return;
            }
        } catch (SecurityException denied) {
            notifyUnavailableAndStop(cb);
            return;
        } catch (RuntimeException ignored) {
            return;
        }
        try {
            cb.onPrimaryClipChanged();
        } catch (RemoteException dead) {
            synchronized (stateLock) {
                if (activeCallback == cb) {
                    stopListeningLocked();
                }
            }
        }
    }

    private void notifyUnavailableAndStop(IClipboardSyncShizukuCallback cb) {
        boolean shouldNotify;
        synchronized (stateLock) {
            shouldNotify = activeCallback == cb;
            if (shouldNotify) {
                stopListeningLocked();
            }
        }
        if (shouldNotify && cb != null) {
            try {
                notifyExecutor.execute(() -> {
                    try {
                        cb.onListenerUnavailable();
                    } catch (RemoteException | RuntimeException ignored) {
                    }
                });
            } catch (RuntimeException ignored) {
            }
        }
    }

    private void teardownInternal() {
        synchronized (stateLock) {
            stopListeningLocked();
        }
        if (ownedExecutor != null) {
            ownedExecutor.shutdownNow();
        }
    }

    private void stopListeningLocked() {
        listening = false;
        ClipboardManager.OnPrimaryClipChangedListener listener = activeOsListener;
        activeOsListener = null;
        IBinder binder = activeCallbackBinder;
        IBinder.DeathRecipient recipient = activeDeathRecipient;
        activeCallback = null;
        activeCallbackBinder = null;
        activeDeathRecipient = null;
        baselineTimestampMs = 0L;
        lastDeliveredTimestampMs = 0L;
        notifyQueued.set(false);
        if (binder != null && recipient != null) {
            try {
                binder.unlinkToDeath(recipient, 0);
            } catch (RuntimeException ignored) {
            }
        }
        if (listener != null) {
            try {
                clipboardBackend.removeListener(listener);
            } catch (RuntimeException ignored) {
            }
        }
    }

    private void enforceAppCaller() {
        if (callingUidSupplier.getAsInt() != appUid) {
            throw new SecurityException("Caller is not this app");
        }
    }

    private static boolean isStaleTimestamp(long clipTs, long baselineTs, long lastDeliveredTs) {
        if (clipTs <= 0L) {
            return false;
        }
        if (baselineTs > 0L && clipTs <= baselineTs) {
            return true;
        }
        return lastDeliveredTs > 0L && clipTs <= lastDeliveredTs;
    }

    private static boolean hasBackgroundClipboardPermission(Context context, int serviceUid) {
        if (!isPrivilegedShizukuUid(serviceUid)) {
            return false;
        }
        try {
            return context.checkPermission(
                    PERMISSION_READ_CLIPBOARD_IN_BACKGROUND,
                    Process.myPid(),
                    serviceUid) == PackageManager.PERMISSION_GRANTED;
        } catch (RuntimeException failure) {
            return false;
        }
    }

    private static boolean isReadClipboardAppOpAllowed(Context context, int serviceUid) {
        if (serviceUid != Process.SHELL_UID) {
            return serviceUid == 0;
        }
        try {
            AppOpsManager appOps = context.getSystemService(AppOpsManager.class);
            if (appOps == null) {
                return true;
            }
            int mode = appOps.unsafeCheckOpNoThrow(OPSTR_READ_CLIPBOARD, serviceUid, SHELL_PACKAGE);
            return mode != AppOpsManager.MODE_ERRORED && mode != AppOpsManager.MODE_IGNORED;
        } catch (RuntimeException ignored) {
            // Fall through to real ClipboardManager registration & SecurityException handling.
            return true;
        }
    }

    private static boolean isUserUnlocked(Context context) {
        try {
            UserManager userManager = context.getSystemService(UserManager.class);
            return userManager == null || userManager.isUserUnlocked();
        } catch (RuntimeException failure) {
            return false;
        }
    }

    private static boolean isDeviceOrScreenLocked(Context context) {
        try {
            KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
            return keyguard != null && (keyguard.isDeviceLocked() || keyguard.isKeyguardLocked());
        } catch (RuntimeException failure) {
            return true;
        }
    }

    /**
     * Narrow shell attribution wrapper used ONLY when public
     * {@link Context#createPackageContext(String, int)} cannot yield a {@code com.android.shell}
     * Context. Mirrors the existing project's Shower {@code FakeContext} approach without
     * broader system-context workarounds.
     */
    private static final class ShellAttributionContext extends ContextWrapper {
        ShellAttributionContext(Context base) {
            super(base);
        }

        @Override
        public String getPackageName() {
            return SHELL_PACKAGE;
        }

        @Override
        public String getOpPackageName() {
            return SHELL_PACKAGE;
        }

        @Override
        public AttributionSource getAttributionSource() {
            return new AttributionSource.Builder(Process.SHELL_UID)
                    .setPackageName(SHELL_PACKAGE)
                    .build();
        }

        @Override
        public Context getApplicationContext() {
            return this;
        }
    }

    private static final class SystemClipboardBackend implements ClipboardBackend {
        private final Context baseContext;
        private volatile ClipboardManager resolvedManager;

        SystemClipboardBackend(Context baseContext) {
            this.baseContext = baseContext;
        }

        @Override
        public boolean addListener(ClipboardManager.OnPrimaryClipChangedListener listener) {
            return runOnMainLooper(() -> {
                ClipboardManager manager = ensureManagerOnMain();
                if (manager == null) {
                    return false;
                }
                try {
                    manager.addPrimaryClipChangedListener(listener);
                    return true;
                } catch (RuntimeException failure) {
                    return false;
                }
            });
        }

        @Override
        public void removeListener(ClipboardManager.OnPrimaryClipChangedListener listener) {
            runOnMainLooper(() -> {
                ClipboardManager manager = resolvedManager;
                if (manager != null) {
                    try {
                        manager.removePrimaryClipChangedListener(listener);
                    } catch (RuntimeException ignored) {
                    }
                }
                return true;
            });
        }

        @Override
        public ClipDescription getPrimaryClipDescription() {
            ClipboardManager manager = resolvedManager;
            if (manager == null) {
                return null;
            }
            return manager.getPrimaryClipDescription();
        }

        @Override
        public ClipData getPrimaryClip() {
            ClipboardManager manager = resolvedManager;
            if (manager == null) {
                return null;
            }
            return manager.getPrimaryClip();
        }

        private ClipboardManager ensureManagerOnMain() {
            ClipboardManager existing = resolvedManager;
            if (existing != null) {
                return existing;
            }
            ClipboardManager created = resolveClipboardManager(baseContext);
            if (created != null) {
                resolvedManager = created;
            }
            return created;
        }

        private static ClipboardManager resolveClipboardManager(Context baseContext) {
            try {
                Context shellContext = baseContext.createPackageContext(SHELL_PACKAGE, 0);
                if (shellContext != null && SHELL_PACKAGE.equals(shellContext.getOpPackageName())) {
                    ClipboardManager manager = shellContext.getSystemService(ClipboardManager.class);
                    if (manager != null) {
                        return manager;
                    }
                }
            } catch (PackageManager.NameNotFoundException | RuntimeException ignored) {
                // Fall through to narrow shell Context shim below.
            }
            return resolveClipboardManagerViaShellShim(baseContext);
        }

        @SuppressLint("SoonBlockedPrivateApi")
        private static ClipboardManager resolveClipboardManagerViaShellShim(Context baseContext) {
            try {
                ClipboardManager manager = baseContext.getSystemService(ClipboardManager.class);
                if (manager == null) {
                    return null;
                }
                ShellAttributionContext shellContext = new ShellAttributionContext(baseContext);
                Field contextField = ClipboardManager.class.getDeclaredField("mContext");
                contextField.setAccessible(true);
                contextField.set(manager, shellContext);
                return manager;
            } catch (ReflectiveOperationException | LinkageError | RuntimeException unavailable) {
                return null;
            }
        }

        private static boolean runOnMainLooper(BooleanSupplier task) {
            Looper mainLooper = Looper.getMainLooper();
            if (mainLooper == null) {
                return false;
            }
            if (Looper.myLooper() == mainLooper) {
                return task.getAsBoolean();
            }
            AtomicBoolean result = new AtomicBoolean(false);
            CountDownLatch latch = new CountDownLatch(1);
            Handler mainHandler = new Handler(mainLooper);
            if (!mainHandler.post(() -> {
                try {
                    result.set(task.getAsBoolean());
                } finally {
                    latch.countDown();
                }
            })) {
                return false;
            }
            try {
                return latch.await(MAIN_OP_TIMEOUT_MS, TimeUnit.MILLISECONDS) && result.get();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
    }
}
