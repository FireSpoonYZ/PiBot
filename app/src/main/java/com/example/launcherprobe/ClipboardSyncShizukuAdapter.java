package com.example.launcherprobe;

import android.content.ComponentName;
import android.content.Context;
import android.content.ServiceConnection;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Binder;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.RemoteException;
import android.os.SystemClock;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import java.util.Objects;

import rikka.shizuku.Shizuku;

/**
 * Default-process client for the dedicated {@link ClipboardSyncShizukuService} Shizuku UserService.
 *
 * <p>Threading &amp; security invariants:
 * <ul>
 *   <li>Only non-blocking {@code Shizuku.bindUserService} / {@code unbindUserService} calls are
 *       posted to the main thread; all AIDL IPC ({@code getInterfaceDescriptor},
 *       {@code startListening}, {@code stopListening}, {@code readFilteredPlainText}) runs strictly
 *       on the controller's background {@code controlWorker} thread.</li>
 *   <li>Never requests Shizuku system permission at runtime (handled separately by foreground
 *       onboarding) and never reuses Shower's service or consent.</li>
 *   <li>Validates callback calling UID against Shizuku's shell/root server UID and unbinds with
 *       {@code remove=true} whenever disabled, offline, revoked, or on binder death / service loss.</li>
 * </ul>
 */
final class ClipboardSyncShizukuAdapter implements ClipboardSyncController.PrivilegedClipboardAdapter {

    private static final String SERVICE_DESCRIPTOR =
            "com.example.launcherprobe.IClipboardSyncShizukuService";
    private static final long BIND_TIMEOUT_MS = 5_000L;
    private static final int MIN_SHIZUKU_USER_SERVICE_VERSION = 10;

    private final Context context;
    private final Handler mainHandler;
    private final int appUid;
    private final Shizuku.UserServiceArgs serviceArgs;

    private final Object lock = new Object();
    private IBinder boundBinder;
    private IClipboardSyncShizukuService boundService;
    private IBinder.DeathRecipient serviceDeathRecipient;
    private boolean binding;
    private boolean bindRequested;
    private boolean wantBound;
    private boolean listenerActive;
    private boolean deadListenerRegistered;
    private long sessionGen;
    private IClipboardSyncShizukuCallback activeCallback;
    private Runnable activeOnUnavailable;

    private final Shizuku.OnBinderDeadListener shizukuDeadListener = this::onShizukuBinderDead;

    private final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            if (binder == null) {
                handleServiceLoss(0L, null);
                return;
            }
            IBinder.DeathRecipient recipient = () -> handleServiceLoss(0L, binder);
            boolean linked = false;
            try {
                binder.linkToDeath(recipient, 0);
                linked = true;
            } catch (RemoteException dead) {
                handleServiceLoss(0L, binder);
                return;
            } catch (RuntimeException failure) {
                handleServiceLoss(0L, binder);
                return;
            }

            IBinder oldBinder = null;
            IBinder.DeathRecipient oldRecipient = null;
            boolean shouldUnbindLate = false;
            synchronized (lock) {
                if (!wantBound) {
                    shouldUnbindLate = true;
                    binding = false;
                } else {
                    oldBinder = boundBinder;
                    oldRecipient = serviceDeathRecipient;
                    boundBinder = binder;
                    boundService = null;
                    serviceDeathRecipient = recipient;
                    binding = false;
                    lock.notifyAll();
                }
            }
            if (oldBinder != null && oldRecipient != null) {
                unlinkQuietly(oldBinder, oldRecipient);
            }
            if (shouldUnbindLate) {
                if (linked) {
                    unlinkQuietly(binder, recipient);
                }
                postUnbind();
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            handleServiceLoss(0L, null);
        }

        @Override
        public void onBindingDied(ComponentName name) {
            handleServiceLoss(0L, null);
        }

        @Override
        public void onNullBinding(ComponentName name) {
            handleServiceLoss(0L, null);
        }
    };

    ClipboardSyncShizukuAdapter(Context context, Handler mainHandler) {
        this.context = Objects.requireNonNull(context).getApplicationContext();
        this.mainHandler = Objects.requireNonNull(mainHandler);
        this.appUid = this.context.getApplicationInfo().uid;
        int userId = appUid / ClipboardSyncShizukuService.PER_USER_RANGE;
        boolean debuggable = (this.context.getApplicationInfo().flags
                & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        this.serviceArgs = new Shizuku.UserServiceArgs(
                new ComponentName(this.context, ClipboardSyncShizukuService.class))
                .tag("clipboard-sync-u" + userId)
                .processNameSuffix("clipboard_sync")
                .daemon(false)
                .debuggable(debuggable)
                .version(2);
    }

    /**
     * Validates that an incoming AIDL callback originates from Shizuku's privileged shell/root
     * process (UID 2000 or UID 0) and matches the expected Shizuku server UID when known.
     */
    static boolean isAllowedShizukuCallbackUid(int callingUid, int expectedShizukuUid) {
        if (!ClipboardSyncShizukuService.isPrivilegedShizukuUid(callingUid)) {
            return false;
        }
        if (expectedShizukuUid >= 0) {
            return callingUid == expectedShizukuUid;
        }
        return true;
    }

    @Override
    public void checkAuthorizationPrerequisites() throws BridgeException {
        int shizukuUid = checkShizukuReadyOrThrow();
        if (!ClipboardSyncShizukuService.isPrivilegedShizukuUid(shizukuUid)
                || !ClipboardSyncShizukuService.isSameUserProfile(appUid, shizukuUid)) {
            throw new BridgeException("UNSUPPORTED", "not-sent", "当前用户配置文件不支持 Shizuku 后台剪贴板同步");
        }
    }

    @Override
    public boolean isListenerActive() {
        synchronized (lock) {
            return listenerActive
                    && boundService != null
                    && boundBinder != null
                    && boundBinder.isBinderAlive();
        }
    }

    @Override
    public boolean startListening(Runnable onPossibleLocalChange, Runnable onListenerUnavailable) {
        if (onPossibleLocalChange == null || Looper.myLooper() == Looper.getMainLooper()) {
            return false;
        }
        int shizukuUid;
        try {
            shizukuUid = checkShizukuReadyOrThrow();
        } catch (BridgeException unavailable) {
            return false;
        }
        if (!ClipboardSyncShizukuService.isPrivilegedShizukuUid(shizukuUid)
                || !ClipboardSyncShizukuService.isSameUserProfile(appUid, shizukuUid)) {
            return false;
        }

        long myGen;
        boolean needRegisterDeadListener;
        boolean needBind;
        synchronized (lock) {
            myGen = ++sessionGen;
            wantBound = true;
            listenerActive = false;
            activeCallback = null;
            activeOnUnavailable = onListenerUnavailable;
            needRegisterDeadListener = !deadListenerRegistered;
            if (needRegisterDeadListener) {
                deadListenerRegistered = true;
            }
            boolean alreadyHasAliveBinder = boundBinder != null && boundBinder.isBinderAlive();
            needBind = !alreadyHasAliveBinder && !binding;
            if (needBind) {
                binding = true;
                bindRequested = true;
            }
        }

        if (needRegisterDeadListener) {
            try {
                Shizuku.addBinderDeadListener(shizukuDeadListener);
            } catch (RuntimeException ignored) {
            }
        }

        if (needBind) {
            mainHandler.post(() -> {
                synchronized (lock) {
                    if (!wantBound || sessionGen != myGen) {
                        if (sessionGen == myGen) {
                            binding = false;
                            lock.notifyAll();
                        }
                        return;
                    }
                }
                try {
                    Shizuku.bindUserService(serviceArgs, serviceConnection);
                } catch (RuntimeException failure) {
                    synchronized (lock) {
                        if (sessionGen == myGen) {
                            binding = false;
                            wantBound = false;
                            lock.notifyAll();
                        }
                    }
                }
            });
        }

        IBinder binder = waitForBinder(myGen);
        if (binder == null || !binder.isBinderAlive()) {
            stopListening();
            return false;
        }

        // Validate interface descriptor on background worker (never on main thread).
        try {
            if (!SERVICE_DESCRIPTOR.equals(binder.getInterfaceDescriptor())) {
                stopListening();
                return false;
            }
        } catch (RemoteException | RuntimeException failure) {
            stopListening();
            return false;
        }

        IClipboardSyncShizukuService service = IClipboardSyncShizukuService.Stub.asInterface(binder);
        if (service == null) {
            stopListening();
            return false;
        }

        IClipboardSyncShizukuCallback callback = new IClipboardSyncShizukuCallback.Stub() {
            @Override
            public void onPrimaryClipChanged() {
                if (!isAllowedShizukuCallbackUid(Binder.getCallingUid(), shizukuUid)) {
                    throw new SecurityException("Unexpected Shizuku clipboard callback caller");
                }
                synchronized (lock) {
                    if (sessionGen != myGen || !listenerActive) {
                        return;
                    }
                }
                onPossibleLocalChange.run();
            }

            @Override
            public void onListenerUnavailable() {
                if (!isAllowedShizukuCallbackUid(Binder.getCallingUid(), shizukuUid)) {
                    throw new SecurityException("Unexpected Shizuku clipboard callback caller");
                }
                handleServiceLoss(myGen, null);
            }
        };

        boolean started;
        try {
            started = service.startListening(callback);
        } catch (RemoteException | RuntimeException failure) {
            started = false;
        }
        if (!started) {
            stopListening();
            return false;
        }

        boolean installed = false;
        synchronized (lock) {
            if (wantBound
                    && sessionGen == myGen
                    && boundBinder == binder
                    && binder.isBinderAlive()) {
                boundService = service;
                activeCallback = callback;
                listenerActive = true;
                installed = true;
            }
        }
        if (!installed) {
            try {
                if (binder.isBinderAlive()) {
                    service.stopListening();
                }
            } catch (RemoteException | RuntimeException ignored) {
            }
            stopListening();
            return false;
        }
        return true;
    }

    @Override
    public void cancelPending() {
        synchronized (lock) {
            sessionGen++;
            wantBound = false;
            listenerActive = false;
            activeCallback = null;
            activeOnUnavailable = null;
            lock.notifyAll();
        }
    }

    @Override
    public void stopListening() {
        IClipboardSyncShizukuService serviceToStop;
        IBinder binderToStop;
        IBinder.DeathRecipient recipientToUnlink;
        boolean needUnbind;
        boolean removeDeadListener;
        synchronized (lock) {
            sessionGen++;
            wantBound = false;
            listenerActive = false;
            activeCallback = null;
            activeOnUnavailable = null;
            serviceToStop = boundService;
            binderToStop = boundBinder;
            recipientToUnlink = serviceDeathRecipient;
            boundService = null;
            boundBinder = null;
            serviceDeathRecipient = null;
            needUnbind = binding || bindRequested || binderToStop != null;
            binding = false;
            bindRequested = false;
            removeDeadListener = deadListenerRegistered;
            deadListenerRegistered = false;
            lock.notifyAll();
        }
        if (removeDeadListener) {
            try {
                Shizuku.removeBinderDeadListener(shizukuDeadListener);
            } catch (RuntimeException ignored) {
            }
        }
        if (binderToStop != null && recipientToUnlink != null) {
            unlinkQuietly(binderToStop, recipientToUnlink);
        }
        if (serviceToStop != null && Looper.myLooper() != Looper.getMainLooper()) {
            try {
                if (serviceToStop.asBinder().isBinderAlive()) {
                    serviceToStop.stopListening();
                }
            } catch (RemoteException | RuntimeException ignored) {
            }
        }
        if (needUnbind) {
            postUnbind();
        }
    }

    @Override
    public String readSendableText() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return null;
        }
        IClipboardSyncShizukuService service;
        IBinder binder;
        long myGen;
        synchronized (lock) {
            if (!listenerActive || boundService == null || boundBinder == null) {
                return null;
            }
            service = boundService;
            binder = boundBinder;
            myGen = sessionGen;
        }
        if (!binder.isBinderAlive()) {
            handleServiceLoss(myGen, binder);
            return null;
        }
        String text;
        try {
            text = service.readFilteredPlainText();
        } catch (RemoteException | RuntimeException failure) {
            handleServiceLoss(myGen, binder);
            return null;
        }
        if (text == null || text.isEmpty()
                || ClipboardSyncController.utf8ByteLength(text) > ClipboardSyncController.MAX_TEXT_BYTES) {
            return null;
        }
        return text;
    }

    private IBinder waitForBinder(long myGen) {
        long deadline = SystemClock.elapsedRealtime() + BIND_TIMEOUT_MS;
        synchronized (lock) {
            while (wantBound && sessionGen == myGen
                    && (boundBinder == null || !boundBinder.isBinderAlive())) {
                if (!binding) {
                    return null;
                }
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0L) {
                    return null;
                }
                try {
                    lock.wait(remaining);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return null;
                }
            }
            if (!wantBound || sessionGen != myGen) {
                return null;
            }
            return boundBinder;
        }
    }

    private void onShizukuBinderDead() {
        handleServiceLoss(0L, null);
    }

    private void handleServiceLoss(long expectedGen, IBinder expectedBinder) {
        IBinder binderToUnlink;
        IBinder.DeathRecipient recipientToUnlink;
        Runnable onUnavailable;
        boolean needUnbind;
        boolean removeDeadListener;
        synchronized (lock) {
            if (expectedGen > 0L && sessionGen != expectedGen) {
                return;
            }
            if (expectedBinder != null && boundBinder != null && boundBinder != expectedBinder) {
                return;
            }
            boolean hadActiveState = wantBound || binding || bindRequested
                    || listenerActive || boundBinder != null || boundService != null;
            if (!hadActiveState) {
                return;
            }
            sessionGen++;
            wantBound = false;
            listenerActive = false;
            activeCallback = null;
            onUnavailable = activeOnUnavailable;
            activeOnUnavailable = null;
            binderToUnlink = boundBinder;
            recipientToUnlink = serviceDeathRecipient;
            boundBinder = null;
            boundService = null;
            serviceDeathRecipient = null;
            needUnbind = binding || bindRequested || binderToUnlink != null;
            binding = false;
            bindRequested = false;
            removeDeadListener = deadListenerRegistered;
            deadListenerRegistered = false;
            lock.notifyAll();
        }
        if (removeDeadListener) {
            try {
                Shizuku.removeBinderDeadListener(shizukuDeadListener);
            } catch (RuntimeException ignored) {
            }
        }
        if (binderToUnlink != null && recipientToUnlink != null) {
            unlinkQuietly(binderToUnlink, recipientToUnlink);
        }
        if (needUnbind) {
            postUnbind();
        }
        if (onUnavailable != null) {
            try {
                onUnavailable.run();
            } catch (RuntimeException ignored) {
            }
        }
    }

    private int checkShizukuReadyOrThrow() throws BridgeException {
        boolean binderAlive;
        try {
            binderAlive = Shizuku.pingBinder();
        } catch (RuntimeException failure) {
            binderAlive = false;
        }
        if (!binderAlive) {
            throw new BridgeException("SHIZUKU_UNAVAILABLE", "not-sent", "未连接到 Shizuku 服务，请先启动 Shizuku");
        }
        int permission;
        try {
            permission = Shizuku.checkSelfPermission();
        } catch (RuntimeException failure) {
            throw new BridgeException("SHIZUKU_UNAVAILABLE", "not-sent", "未连接到 Shizuku 服务，请先启动 Shizuku");
        }
        if (permission != PackageManager.PERMISSION_GRANTED) {
            throw new BridgeException(
                    "SHIZUKU_PERMISSION_REQUIRED",
                    "not-sent",
                    "尚未授予本应用 Shizuku 权限，请先在设置中完成 Shizuku 授权");
        }
        int version;
        int shizukuUid;
        try {
            version = Shizuku.getVersion();
            shizukuUid = Shizuku.getUid();
        } catch (RuntimeException failure) {
            throw new BridgeException("SHIZUKU_UNAVAILABLE", "not-sent", "Shizuku 服务状态不可用");
        }
        if (version < MIN_SHIZUKU_USER_SERVICE_VERSION) {
            throw new BridgeException("UNSUPPORTED", "not-sent", "当前 Shizuku 版本过低，不支持后台剪贴板同步");
        }
        return shizukuUid;
    }

    private void postUnbind() {
        mainHandler.post(() -> {
            try {
                if (Shizuku.pingBinder()) {
                    Shizuku.unbindUserService(serviceArgs, serviceConnection, true);
                }
            } catch (RuntimeException ignored) {
            }
        });
    }

    private static void unlinkQuietly(IBinder binder, IBinder.DeathRecipient recipient) {
        try {
            binder.unlinkToDeath(recipient, 0);
        } catch (RuntimeException ignored) {
        }
    }
}
