package com.example.launcherprobe;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.content.ContextCompat;

import com.ai.assistance.shower.IShowerService;
import com.ai.assistance.shower.ShowerBinderContainer;

import java.util.UUID;

import rikka.shizuku.Shizuku;

/** Starts the app-owned Shower process and accepts its authenticated Binder handoff. */
final class ShowerManager {
    private static final String ACTION_BINDER_READY =
            "com.ai.assistance.operit.action.SHOWER_BINDER_READY";
    private static final String EXTRA_BINDER_CONTAINER = "binder_container";
    private static final String EXTRA_HANDOFF_TOKEN = "handoff_token";
    private static final long CONNECTION_TIMEOUT_MS = 12_000;

    /** 进程级共享：本应用内所有 ShowerToolBridge 共用一台 Shower 服务，最后释放者才停服。 */
    private static final Object SHARED_LOCK = new Object();
    private static ShowerManager sharedInstance;
    private static int sharedOwners;
    private static boolean retiring;
    private volatile boolean retired;

    /** 非阻塞尝试：收尾期间不等待并返回 null（由调用方稍后在 worker 上再阻塞获取）。 */
    static ShowerManager tryAcquire(Context context) {
        synchronized (SHARED_LOCK) {
            if (retiring) return null;
            if (sharedInstance == null) sharedInstance = new ShowerManager(context);
            sharedOwners++;
            return sharedInstance;
        }
    }

    private final Context context;
    private final Object lock = new Object();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Shizuku.UserServiceArgs serviceArgs;
    private volatile IShowerService service;
    private volatile String expectedToken;
    private volatile boolean serverStarted;
    private IOwnPermissionService shell;
    private boolean bindingShell;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context ignored, Intent intent) {
            if (!ACTION_BINDER_READY.equals(intent.getAction())) return;
            String token = intent.getStringExtra(EXTRA_HANDOFF_TOKEN);
            if (token == null || !token.equals(expectedToken)) return;
            try {
                intent.setExtrasClassLoader(ShowerBinderContainer.class.getClassLoader());
                ShowerBinderContainer container = Build.VERSION.SDK_INT >= 33
                        ? intent.getParcelableExtra(EXTRA_BINDER_CONTAINER,
                                ShowerBinderContainer.class)
                        : intent.getParcelableExtra(EXTRA_BINDER_CONTAINER);
                IBinder binder = container == null ? null : container.getBinder();
                if (binder == null || !"com.ai.assistance.shower.IShowerService".equals(
                        binder.getInterfaceDescriptor())) return;
                IShowerService received = IShowerService.Stub.asInterface(binder);
                binder.linkToDeath(() -> clearService(binder), 0);
                synchronized (lock) {
                    service = received;
                    lock.notifyAll();
                }
            } catch (Exception ignoredException) {
                // A malformed or already-dead handoff is ignored; the waiting request reports timeout.
            }
        }
    };

    private final ServiceConnection shellConnection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            synchronized (lock) {
                shell = IOwnPermissionService.Stub.asInterface(binder);
                bindingShell = false;
                lock.notifyAll();
            }
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            synchronized (lock) {
                shell = null;
                bindingShell = false;
                lock.notifyAll();
            }
        }
    };

    ShowerManager(Context context) {
        this.context = context.getApplicationContext();
        int userId = context.getApplicationInfo().uid / 100000;
        serviceArgs = new Shizuku.UserServiceArgs(
                new ComponentName(context, OwnPermissionService.class))
                .tag("shower-manager-u" + userId)
                .processNameSuffix("shower_manager")
                .daemon(false)
                .debuggable((context.getApplicationInfo().flags
                        & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
                .version(1);
        IntentFilter filter = new IntentFilter(ACTION_BINDER_READY);
        ContextCompat.registerReceiver(this.context, receiver, filter,
                ContextCompat.RECEIVER_EXPORTED);
    }

    static ShowerManager acquire(Context context) {
        synchronized (SHARED_LOCK) {
            while (retiring) {
                try {
                    SHARED_LOCK.wait();
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("等待旧 Shower 服务收尾被中断");
                }
            }
            if (sharedInstance == null) sharedInstance = new ShowerManager(context);
            sharedOwners++;
            return sharedInstance;
        }
    }

    /** 归还租约；仅最后一位持有者在独占区外完成收尾，新 acquire 会等待其结束后再建新实例。 */
    void release() {
        boolean last;
        synchronized (SHARED_LOCK) {
            if (retired) return;
            if (sharedOwners > 0) sharedOwners--;
            last = sharedOwners <= 0 && !retiring;
            if (last) {
                retired = true;
                retiring = true;
                sharedInstance = null;
            }
        }
        if (last) {
            try {
                teardown();
            } finally {
                synchronized (SHARED_LOCK) {
                    retiring = false;
                    SHARED_LOCK.notifyAll();
                }
            }
        }
    }

    private void teardown() {
        // 未启动过服务器或已空闲退出时，不为此绑定 Shizuku。
        if (serverStarted && aliveService() != null) stopServer();
        else unbindShell();
        serverStarted = false;
        try {
            context.unregisterReceiver(receiver);
        } catch (IllegalArgumentException ignored) {
            // 未注册或已注销。
        }
    }

    synchronized IShowerService ensureService() throws Exception {
        IShowerService alive = aliveService();
        if (alive != null) return alive;
        IOwnPermissionService remote = ensureShellService();
        String token = UUID.randomUUID().toString();
        expectedToken = token;
        String error = remote.startShowerServer(token);
        if (error != null && !error.isEmpty()) {
            expectedToken = null;
            throw new IllegalStateException("Operit Shower 启动失败：" + error);
        }
        serverStarted = true;
        long deadline = android.os.SystemClock.elapsedRealtime() + CONNECTION_TIMEOUT_MS;
        synchronized (lock) {
            for (;;) {
                alive = aliveService();
                if (alive != null) return alive;
                long remaining = deadline - android.os.SystemClock.elapsedRealtime();
                if (remaining <= 0) break;
                lock.wait(remaining);
            }
        }
        expectedToken = null;
        throw new IllegalStateException("Operit Shower Binder 连接超时；请确认 Shizuku 已授权");
    }

    IShowerService aliveService() {
        IShowerService current = service;
        if (current != null && current.asBinder().isBinderAlive()) return current;
        if (current != null) clearService(current.asBinder());
        return null;
    }

    String stopServer() {
        clearService(null);
        try {
            IOwnPermissionService remote = ensureShellService();
            String error = remote.stopShowerServer();
            unbindShell();
            return error == null ? "" : error;
        } catch (Exception exception) {
            unbindShell();
            return exception.getClass().getSimpleName() + ": " + exception.getMessage();
        }
    }

    private IOwnPermissionService ensureShellService() throws Exception {
        if (!Shizuku.pingBinder()) throw new IllegalStateException("Shizuku 未运行");
        if (Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED) {
            throw new SecurityException("尚未授予本应用 Shizuku 权限");
        }
        long deadline = android.os.SystemClock.elapsedRealtime() + CONNECTION_TIMEOUT_MS;
        synchronized (lock) {
            if (shell != null && shell.asBinder().isBinderAlive()) return shell;
            if (!bindingShell) {
                bindingShell = true;
                main.post(() -> {
                    try {
                        Shizuku.bindUserService(serviceArgs, shellConnection);
                    } catch (RuntimeException exception) {
                        synchronized (lock) {
                            bindingShell = false;
                            lock.notifyAll();
                        }
                    }
                });
            }
            while (shell == null || !shell.asBinder().isBinderAlive()) {
                long remaining = deadline - android.os.SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    bindingShell = false;
                    throw new IllegalStateException("Shizuku Shower 服务连接超时");
                }
                lock.wait(remaining);
            }
            return shell;
        }
    }

    private void clearService(IBinder expected) {
        synchronized (lock) {
            if (expected == null || service != null && service.asBinder() == expected) {
                service = null;
                expectedToken = null;
                lock.notifyAll();
            }
        }
    }

    private void unbindShell() {
        synchronized (lock) {
            shell = null;
            bindingShell = false;
        }
        main.post(() -> {
            try {
                Shizuku.unbindUserService(serviceArgs, shellConnection, true);
            } catch (RuntimeException ignored) { }
        });
    }
}
