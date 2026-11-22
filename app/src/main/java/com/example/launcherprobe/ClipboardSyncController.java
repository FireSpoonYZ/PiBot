package com.example.launcherprobe;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.function.BooleanSupplier;

/**
 * Default-process controller for Android clipboard sync (manual send / automatic receive, plus
 * optional foreground-authorized Shizuku background automatic outbound).
 *
 * <p>Uses {@link BotClientService} foreground lifecycle and generation-fenced encrypted
 * {@link CenterClientCredentials} via {@link BotHostClient}, persisting the independent switch,
 * group code, and clipboard-specific background authorization in {@link ClipboardSyncStorage}
 * scoped to the active Center binding.
 *
 * <p>Incoming remote text is written automatically to the OS clipboard in the default process
 * with our own clip marker and {@link ClipDescription#EXTRA_IS_SENSITIVE}, bounded to at most
 * one latest pending write and rechecked against app enabled state, lifecycle, credentials,
 * and native online generation on every callback.
 *
 * <p>Outgoing text supports explicit {@code sendNow} read in the focused real Activity
 * ({@link BotHostTauriPlugin}) over the private same-UID bridge, and optional background automatic
 * observation via {@link ClipboardSyncShizukuAdapter} only after explicit foreground consent and
 * only while the native relay link is active-online. Any Shizuku failure cleanly falls back to
 * {@code "manual"} mode while keeping manual {@code sendNow} and automatic receiving intact.
 */
final class ClipboardSyncController {

    static final String OWN_CLIP_LABEL = "pibot-clipboard-sync";
    static final String SHOWER_CLIP_LABEL = "pibot";
    static final String EXTRA_OWN_SYNC = "com.example.launcherprobe.clipboard_sync.OWN";
    static final int MAX_TEXT_BYTES = 65_536;

    static final String MODE_AUTOMATIC = "automatic";
    static final String MODE_MANUAL = "manual";
    static final String MODE_UNSUPPORTED = "unsupported";

    static final String CONNECTION_OFF = "off";
    static final String CONNECTION_NOT_PAIRED = "notPaired";
    static final String CONNECTION_CONNECTING = "connecting";
    static final String CONNECTION_ONLINE = "online";
    static final String CONNECTION_OFFLINE = "offline";
    static final String CONNECTION_UNAUTHORIZED = "unauthorized";
    static final String CONNECTION_UNSUPPORTED = "unsupported";
    static final String CONNECTION_CERTIFICATE_ERROR = "certificateError";
    static final String CONNECTION_GROUP_FULL = "groupFull";
    static final String CONNECTION_REPLACED = "replaced";

    private static final long WATCH_CONNECTING_INTERVAL_MS = 500L;
    private static final long WATCH_ONLINE_INTERVAL_MS = 2_500L;
    private static final long ADAPTER_RETRY_BACKOFF_MS = 15_000L;

    private static final Object INSTANCE_LOCK = new Object();
    private static ClipboardSyncController instance;

    interface TextReceiver {
        void onText(long generation, String text);
    }

    interface NativeBridge {
        boolean isSupported();

        String generateGroupCode();

        boolean validGroupCode(String code);

        long start(String origin, String deviceId, String token, String caPem, String code, TextReceiver receiver);

        String status(long handle);

        long onlineGeneration(long handle);

        boolean send(long handle, long generation, String text);

        void stop(long handle);
    }

    interface CredentialsProvider {
        BotHostClient.ClipboardCredentials current();
    }

    interface ClipboardWriter {
        void writeIncomingText(String text);
    }

    /**
     * Narrow seam for the optional privileged Android background clipboard adapter
     * ({@link ClipboardSyncShizukuAdapter}). Kept stopped and unbound while off, unauthorized,
     * or not active-online; reports {@code mode == "automatic"} only with a live authenticated
     * listener.
     */
    interface PrivilegedClipboardAdapter {
        void checkAuthorizationPrerequisites() throws BridgeException;

        boolean isListenerActive();

        boolean startListening(Runnable onPossibleLocalChange, Runnable onListenerUnavailable);

        default void cancelPending() {
        }

        void stopListening();

        String readSendableText();
    }

    static final class ClipReadResult {
        final boolean ok;
        final String text;
        final String errorCode;
        final String errorMessage;

        private ClipReadResult(boolean ok, String text, String errorCode, String errorMessage) {
            this.ok = ok;
            this.text = text;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }

        static ClipReadResult ok(String text) {
            return new ClipReadResult(true, text, null, null);
        }

        static ClipReadResult error(String code, String message) {
            return new ClipReadResult(false, null, code, message);
        }
    }

    private static final class PendingWrite {
        final long linkEpoch;
        final long handle;
        final String bindingKey;
        final long credentialGeneration;
        final long nativeGeneration;
        final String text;

        PendingWrite(long linkEpoch, long handle, String bindingKey, long credentialGeneration,
                     long nativeGeneration, String text) {
            this.linkEpoch = linkEpoch;
            this.handle = handle;
            this.bindingKey = bindingKey;
            this.credentialGeneration = credentialGeneration;
            this.nativeGeneration = nativeGeneration;
            this.text = text;
        }
    }

    private static final class PendingCapture {
        final long linkEpoch;
        final long handle;
        final String bindingKey;
        final long credentialGeneration;
        final long onlineGeneration;

        PendingCapture(long linkEpoch, long handle, String bindingKey, long credentialGeneration,
                       long onlineGeneration) {
            this.linkEpoch = linkEpoch;
            this.handle = handle;
            this.bindingKey = bindingKey;
            this.credentialGeneration = credentialGeneration;
            this.onlineGeneration = onlineGeneration;
        }
    }

    private static final class DefaultNativeBridge implements NativeBridge {
        private final AtomicBoolean probed = new AtomicBoolean();
        private final AtomicBoolean unavailable = new AtomicBoolean();

        @Override
        public boolean isSupported() {
            if (unavailable.get()) {
                return false;
            }
            if (probed.compareAndSet(false, true)) {
                try {
                    ClipboardSyncNative.validGroupCode("");
                } catch (LinkageError missing) {
                    unavailable.set(true);
                    return false;
                }
            }
            return !unavailable.get();
        }

        @Override
        public String generateGroupCode() {
            if (!isSupported()) {
                return null;
            }
            try {
                return ClipboardSyncNative.generateGroupCode();
            } catch (LinkageError missing) {
                unavailable.set(true);
                return null;
            }
        }

        @Override
        public boolean validGroupCode(String code) {
            if (code == null || !isSupported()) {
                return false;
            }
            try {
                return ClipboardSyncNative.validGroupCode(code);
            } catch (LinkageError missing) {
                unavailable.set(true);
                return false;
            }
        }

        @Override
        public long start(String origin, String deviceId, String token, String caPem, String code,
                          TextReceiver receiver) {
            if (!isSupported()) {
                return 0L;
            }
            try {
                return ClipboardSyncNative.start(origin, deviceId, token, caPem, code, receiver::onText);
            } catch (LinkageError missing) {
                unavailable.set(true);
                return 0L;
            }
        }

        @Override
        public String status(long handle) {
            if (handle == 0L) {
                return CONNECTION_OFFLINE;
            }
            if (!isSupported()) {
                return CONNECTION_UNSUPPORTED;
            }
            try {
                return ClipboardSyncNative.status(handle);
            } catch (LinkageError missing) {
                unavailable.set(true);
                return CONNECTION_UNSUPPORTED;
            }
        }

        @Override
        public long onlineGeneration(long handle) {
            if (handle == 0L || !isSupported()) {
                return 0L;
            }
            try {
                return ClipboardSyncNative.onlineGeneration(handle);
            } catch (LinkageError missing) {
                unavailable.set(true);
                return 0L;
            }
        }

        @Override
        public boolean send(long handle, long generation, String text) {
            if (handle == 0L || generation == 0L || text == null || !isSupported()) {
                return false;
            }
            try {
                return ClipboardSyncNative.send(handle, generation, text);
            } catch (LinkageError missing) {
                unavailable.set(true);
                return false;
            }
        }

        @Override
        public void stop(long handle) {
            if (handle == 0L || unavailable.get()) {
                return;
            }
            try {
                ClipboardSyncNative.stop(handle);
            } catch (LinkageError missing) {
                unavailable.set(true);
            }
        }
    }

    private final ClipboardSyncStorage storage;
    private final NativeBridge nativeBridge;
    private final CredentialsProvider credentialsProvider;
    private final BooleanSupplier lifecycleOpen;
    private final ClipboardWriter clipboardWriter;
    private final Executor mainExecutor;
    private final PrivilegedClipboardAdapter privilegedAdapter;
    private final ExecutorService controlWorker;

    /**
     * Fast in-memory lock only: NEVER hold across JNI start/stop/send/onlineGeneration,
     * storage I/O, or OS clipboard calls, preventing callback-vs-stop deadlocks.
     */
    private final Object stateLock = new Object();
    /**
     * RCU-style barrier protecting non-controlWorker {@code onlineGeneration(handle)} calls
     * from racing with {@code nativeBridge.stop(handle)}. Readers hold readLock only around
     * verifying {@code activeHandle} + reading {@code onlineGeneration}; {@code stopDetachedHandle}
     * acquires and immediately releases writeLock after {@code activeHandle} is cleared, then
     * calls {@code nativeBridge.stop(handle)} with no locks held.
     */
    private final ReentrantReadWriteLock handleCallLock = new ReentrantReadWriteLock();
    private long linkEpoch;
    private long activeHandle;
    private String activeBindingKey;
    private long activeCredentialGeneration = -1L;
    private String activeGroupCode;
    private boolean currentEnabled;
    private boolean currentBackgroundAuthorized;
    private long observedLinkEpoch;
    private long observedOnlineGeneration;
    private PendingWrite pendingIncoming;
    private boolean incomingWriteScheduled;
    private PendingCapture pendingPrivilegedCapture;
    private boolean privilegedCaptureScheduled;

    private final AtomicBoolean reconcileQueued = new AtomicBoolean();
    private final AtomicBoolean resetBackoffPending = new AtomicBoolean();
    private final Object watchLock = new Object();
    private ScheduledFuture<?> onlineWatchFuture;
    private long nextAdapterAttemptAtMs;

    static ClipboardSyncController get(Context context) {
        synchronized (INSTANCE_LOCK) {
            if (instance == null) {
                Context app = context.getApplicationContext();
                Handler mainHandler = new Handler(Looper.getMainLooper());
                instance = new ClipboardSyncController(
                        new ClipboardSyncStorage(app),
                        new DefaultNativeBridge(),
                        () -> BotHostClient.get(app).clipboardSyncCredentials(),
                        BotClientService::isActive,
                        text -> writeClipToSystem(app, text),
                        mainHandler::post,
                        new ClipboardSyncShizukuAdapter(app, mainHandler),
                        newControlWorker());
            }
            return instance;
        }
    }

    ClipboardSyncController(ClipboardSyncStorage storage,
                            NativeBridge nativeBridge,
                            CredentialsProvider credentialsProvider,
                            BooleanSupplier lifecycleOpen,
                            ClipboardWriter clipboardWriter,
                            Executor mainExecutor,
                            PrivilegedClipboardAdapter privilegedAdapter,
                            ExecutorService controlWorker) {
        this.storage = Objects.requireNonNull(storage);
        this.nativeBridge = Objects.requireNonNull(nativeBridge);
        this.credentialsProvider = Objects.requireNonNull(credentialsProvider);
        this.lifecycleOpen = Objects.requireNonNull(lifecycleOpen);
        this.clipboardWriter = Objects.requireNonNull(clipboardWriter);
        this.mainExecutor = Objects.requireNonNull(mainExecutor);
        this.privilegedAdapter = privilegedAdapter;
        this.controlWorker = Objects.requireNonNull(controlWorker);
    }

    private static ScheduledExecutorService newControlWorker() {
        return Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "clipboard-sync-control");
            thread.setDaemon(true);
            return thread;
        });
    }

    // ---------- Static clipboard reading & writing (safe from :tauri_ui and default process) ----------

    /**
     * Builds the OS {@link ClipData} written on incoming sync: marked as own clip and
     * {@link ClipDescription#EXTRA_IS_SENSITIVE} so Android 13+ suppresses clipboard previews.
     */
    static ClipData buildIncomingClip(String text) {
        ClipData clip = ClipData.newPlainText(OWN_CLIP_LABEL, text);
        PersistableBundle extras = new PersistableBundle();
        extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
        extras.putBoolean(EXTRA_OWN_SYNC, true);
        clip.getDescription().setExtras(extras);
        return clip;
    }

    private static void writeClipToSystem(Context context, String text) {
        if (text == null) {
            return;
        }
        try {
            ClipboardManager manager = context.getSystemService(ClipboardManager.class);
            if (manager == null) {
                return;
            }
            manager.setPrimaryClip(buildIncomingClip(text));
        } catch (RuntimeException ignored) {
            // Never log clipboard content or crash default service on OEM clipboard restrictions.
        }
    }

    /**
     * Strictly validates and reads plain text from the OS clipboard without dereferencing
     * any URI or Intent. Checks description before {@link ClipboardManager#getPrimaryClip()}
     * and rechecks on the returned {@link ClipData}.
     */
    static ClipReadResult readSendableClip(ClipboardManager clipboard) {
        if (clipboard == null) {
            return ClipReadResult.error("CLIPBOARD_UNAVAILABLE", "系统剪贴板不可用");
        }
        ClipDescription description;
        try {
            description = clipboard.getPrimaryClipDescription();
        } catch (SecurityException denied) {
            return ClipReadResult.error("CLIPBOARD_DENIED", "无法读取系统剪贴板");
        } catch (RuntimeException failure) {
            return ClipReadResult.error("CLIPBOARD_UNAVAILABLE", "无法读取系统剪贴板");
        }
        ClipReadResult descError = validateDescription(description);
        if (descError != null) {
            return descError;
        }
        ClipData clip;
        try {
            clip = clipboard.getPrimaryClip();
        } catch (SecurityException denied) {
            return ClipReadResult.error("CLIPBOARD_DENIED", "无法读取系统剪贴板");
        } catch (RuntimeException failure) {
            return ClipReadResult.error("CLIPBOARD_UNAVAILABLE", "无法读取系统剪贴板");
        }
        return extractSendableText(clip);
    }

    /**
     * Extracts plain text from a {@link ClipData} strictly without dereferencing URI/Intent:
     * Reads only the explicit plain-text representation, even for newHtmlText. Files, intents,
     * sensitive, own or Shower clips and multi-item clips are not read.
     */
    static ClipReadResult extractSendableText(ClipData clip) {
        if (clip == null || clip.getItemCount() <= 0) {
            return ClipReadResult.error("CLIPBOARD_EMPTY", "剪贴板为空");
        }
        ClipReadResult descError = validateDescription(clip.getDescription());
        if (descError != null) {
            return descError;
        }
        if (clip.getItemCount() != 1) {
            return ClipReadResult.error("CLIPBOARD_UNSUPPORTED", "仅支持纯文本剪贴板");
        }
        ClipData.Item item = clip.getItemAt(0);
        if (item == null) {
            return ClipReadResult.error("CLIPBOARD_EMPTY", "剪贴板为空");
        }
        // Strictly inspect raw fields; NEVER call coerceToText/coerceToStyledText/coerceToHtmlText.
        if (item.getUri() != null) {
            return ClipReadResult.error("CLIPBOARD_UNSUPPORTED", "不支持发送链接或文件剪贴板");
        }
        if (item.getIntent() != null) {
            return ClipReadResult.error("CLIPBOARD_UNSUPPORTED", "不支持发送应用意图剪贴板");
        }
        return validatePlainText(item.getText());
    }

    static ClipReadResult validatePlainText(CharSequence rawText) {
        if (rawText == null) {
            return ClipReadResult.error("CLIPBOARD_UNSUPPORTED", "仅支持纯文本剪贴板");
        }
        if (rawText.length() == 0) {
            return ClipReadResult.error("CLIPBOARD_EMPTY", "剪贴板为空");
        }
        if (rawText.length() > MAX_TEXT_BYTES) {
            return ClipReadResult.error("CLIPBOARD_TOO_LARGE", "剪贴板文本超过大小限制");
        }
        String text = rawText.toString();
        int utf8Length = utf8ByteLength(text);
        if (utf8Length < 0) {
            return ClipReadResult.error("CLIPBOARD_UNSUPPORTED", "剪贴板文本编码无效");
        }
        if (utf8Length > MAX_TEXT_BYTES) {
            return ClipReadResult.error("CLIPBOARD_TOO_LARGE", "剪贴板文本超过大小限制");
        }
        if (text.indexOf('\0') >= 0 || text.contains("pibot1.") || text.contains("pibot-clipboard-v1:")) {
            return ClipReadResult.error("CLIPBOARD_REJECTED", "此文本不允许同步");
        }
        return ClipReadResult.ok(text);
    }

    static int utf8ByteLength(String text) {
        int bytes = 0;
        int len = text.length();
        for (int i = 0; i < len; i++) {
            char c = text.charAt(i);
            if (c < 0x80) {
                bytes += 1;
            } else if (c < 0x800) {
                bytes += 2;
            } else if (Character.isHighSurrogate(c)
                    && i + 1 < len
                    && Character.isLowSurrogate(text.charAt(i + 1))) {
                bytes += 4;
                i++;
            } else if (Character.isSurrogate(c)) {
                return -1;
            } else {
                bytes += 3;
            }
            if (bytes > MAX_TEXT_BYTES) {
                return bytes;
            }
        }
        return bytes;
    }

    static ClipReadResult validateDescription(ClipDescription description) {
        if (description == null) {
            return ClipReadResult.error("CLIPBOARD_EMPTY", "剪贴板为空");
        }
        PersistableBundle extras = description.getExtras();
        if (isTruthyExtra(extras, EXTRA_OWN_SYNC)) {
            return ClipReadResult.error("CLIPBOARD_REJECTED", "当前剪贴板内容已同步");
        }
        if (isTruthyExtra(extras, ClipDescription.EXTRA_IS_SENSITIVE)) {
            return ClipReadResult.error("CLIPBOARD_SENSITIVE", "敏感剪贴板内容不会同步");
        }
        CharSequence label = description.getLabel();
        if (label != null) {
            String labelText = label.toString();
            if (OWN_CLIP_LABEL.equals(labelText)) {
                return ClipReadResult.error("CLIPBOARD_REJECTED", "当前剪贴板内容已同步");
            }
            if (SHOWER_CLIP_LABEL.equals(labelText)) {
                return ClipReadResult.error("CLIPBOARD_REJECTED", "暂不同步受控屏幕剪贴板内容");
            }
        }
        int mimeCount = description.getMimeTypeCount();
        // Android's newHtmlText advertises only text/html but requires Item.getText().
        if (mimeCount == 0) {
            return ClipReadResult.error("CLIPBOARD_UNSUPPORTED", "仅支持纯文本剪贴板");
        }
        for (int i = 0; i < mimeCount; i++) {
            String mime = description.getMimeType(i);
            if (!ClipDescription.MIMETYPE_TEXT_PLAIN.equals(mime)
                    && !ClipDescription.MIMETYPE_TEXT_HTML.equals(mime)) {
                return ClipReadResult.error("CLIPBOARD_UNSUPPORTED", "仅支持纯文本剪贴板");
            }
        }
        return null;
    }

    @SuppressWarnings("deprecation")
    private static boolean isTruthyExtra(PersistableBundle extras, String key) {
        if (extras == null || !extras.containsKey(key)) {
            return false;
        }
        Object value = extras.get(key);
        if (value instanceof Boolean) {
            return (Boolean) value;
        }
        if (value instanceof Number) {
            return ((Number) value).longValue() != 0L;
        }
        return false;
    }

    static String normalizeNativeStatus(String raw) {
        if (raw == null) {
            return CONNECTION_OFFLINE;
        }
        switch (raw) {
            case CONNECTION_CONNECTING:
            case CONNECTION_ONLINE:
            case CONNECTION_OFFLINE:
            case CONNECTION_UNAUTHORIZED:
            case CONNECTION_UNSUPPORTED:
            case CONNECTION_CERTIFICATE_ERROR:
            case CONNECTION_GROUP_FULL:
            case CONNECTION_REPLACED:
                return raw;
            default:
                return CONNECTION_OFFLINE;
        }
    }

    // ---------- Lifecycle & Center state hooks (called in default process) ----------

    void onLifecycleStarted() {
        scheduleReconcile(true);
    }

    void onNetworkAvailable() {
        scheduleReconcile(true);
    }

    /**
     * Immediately fences any running native link and discards any pending incoming OS write.
     * When {@code disconnected} is true (explicit Center disconnect), also clears persisted
     * clipboard sync state on the serial control worker.
     */
    void onCenterStateChanged(boolean disconnected) {
        long detached = detachActiveLinkLocked();
        cancelPrivilegedPending();
        controlWorker.execute(() -> {
            nextAdapterAttemptAtMs = 0L;
            stopDetachedHandle(detached);
            if (disconnected) {
                try {
                    storage.clear();
                } catch (IOException ignored) {
                    // Best-effort clear on disconnect; binding scoping still prevents migration.
                }
            }
            reconcileQuietly();
        });
    }

    /**
     * Explicit service exit / destroy: synchronously fences all callbacks and pending writes,
     * then stops any active native handle on the serial control worker. Never fails exit.
     */
    CompletableFuture<Void> shutdown() {
        long detached = detachActiveLinkLocked();
        cancelPrivilegedPending();
        CompletableFuture<Void> done = new CompletableFuture<>();
        controlWorker.execute(() -> {
            try {
                stopDetachedHandle(detached);
                long remaining = detachActiveLinkLocked();
                stopDetachedHandle(remaining);
            } catch (Throwable ignored) {
                // Never block BotClientService exit on native stop anomalies.
            } finally {
                done.complete(null);
            }
        });
        return done;
    }

    private void scheduleReconcile(boolean resetAdapterBackoff) {
        if (resetAdapterBackoff) {
            resetBackoffPending.set(true);
        }
        if (!reconcileQueued.compareAndSet(false, true)) {
            return;
        }
        controlWorker.execute(() -> {
            reconcileQueued.set(false);
            if (resetBackoffPending.getAndSet(false)) {
                nextAdapterAttemptAtMs = 0L;
            }
            reconcileQuietly();
        });
    }

    private void reconcileQuietly() {
        try {
            reconcileOnControl();
        } catch (Throwable ignored) {
            // Background reconcile stops invalid links safely without logging secrets.
        }
    }

    // ---------- Action entrypoints (called via private bridge from BotHostUiBridgeService) ----------

    CompletableFuture<JSONObject> handleAction(JSONObject params) {
        if (params == null) {
            return failed(new BridgeException("INVALID_ARGUMENT", "not-sent", "剪贴板同步参数无效"));
        }
        Object rawAction = params.opt("action");
        if (!(rawAction instanceof String)) {
            return failed(new BridgeException("INVALID_ARGUMENT", "not-sent", "action 无效"));
        }
        String action = (String) rawAction;
        switch (action) {
            case "status":
                if (params.length() != 1) {
                    return failed(new BridgeException("INVALID_ARGUMENT", "not-sent", "status 参数无效"));
                }
                return onControl(this::actionStatus);
            case "setEnabled":
                if (params.length() != 2 || !(params.opt("enabled") instanceof Boolean)) {
                    return failed(new BridgeException("INVALID_ARGUMENT", "not-sent", "enabled 必须为布尔值"));
                }
                boolean enabled = (Boolean) params.opt("enabled");
                if (!enabled) {
                    long detached = detachActiveLinkLocked();
                    cancelPrivilegedPending();
                    return onControl(() -> {
                        stopDetachedHandle(detached);
                        return actionSetEnabled(false);
                    });
                }
                return onControl(() -> actionSetEnabled(true));
            case "newGroup":
                if (params.length() != 1) {
                    return failed(new BridgeException("INVALID_ARGUMENT", "not-sent", "newGroup 参数无效"));
                }
                return onControl(this::actionNewGroup);
            case "joinGroup":
                if (params.length() != 2 || !(params.opt("code") instanceof String)) {
                    return failed(new BridgeException("INVALID_ARGUMENT", "not-sent", "code 无效"));
                }
                String code = (String) params.opt("code");
                return onControl(() -> actionJoinGroup(code));
            case "showCode":
                if (params.length() != 1) {
                    return failed(new BridgeException("INVALID_ARGUMENT", "not-sent", "showCode 参数无效"));
                }
                return onControl(this::actionShowCode);
            case "authorizeBackground":
                if (params.length() != 1) {
                    return failed(new BridgeException("INVALID_ARGUMENT", "not-sent", "authorizeBackground 参数无效"));
                }
                return onControl(this::actionAuthorizeBackground);
            case "revokeBackground":
                if (params.length() != 1) {
                    return failed(new BridgeException("INVALID_ARGUMENT", "not-sent", "revokeBackground 参数无效"));
                }
                synchronized (stateLock) {
                    currentBackgroundAuthorized = false;
                    observedLinkEpoch = 0L;
                    observedOnlineGeneration = 0L;
                    pendingPrivilegedCapture = null;
                }
                cancelPrivilegedPending();
                return onControl(this::actionRevokeBackground);
            default:
                // sendNow MUST arrive through private bridge op "clipboardSyncSend", never via web params.
                return failed(new BridgeException("INVALID_ARGUMENT", "not-sent", "不支持的剪贴板同步操作"));
        }
    }

    /**
     * Private bridge-only entrypoint for Android manual {@code sendNow}. Plaintext is read natively
     * in the focused real Activity and never returned to WebView.
     */
    CompletableFuture<JSONObject> sendNow(String text) {
        ClipReadResult checked = validatePlainText(text == null ? "" : text);
        if (!checked.ok) {
            return failed(new BridgeException(checked.errorCode, "not-sent", checked.errorMessage));
        }
        return onControl(() -> actionSendNow(checked.text));
    }

    private CompletableFuture<JSONObject> onControl(ControlAction action) {
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        controlWorker.execute(() -> {
            try {
                future.complete(action.run());
            } catch (Throwable failure) {
                future.completeExceptionally(failure);
            }
        });
        return future;
    }

    private interface ControlAction {
        JSONObject run() throws Exception;
    }

    // ---------- Actions (always executed serially on controlWorker) ----------

    private JSONObject actionStatus() throws Exception {
        JSONObject status = reconcileOnControl();
        return reply(status, null);
    }

    private JSONObject actionSetEnabled(boolean enabled) throws Exception {
        if (!nativeBridge.isSupported()) {
            stopActiveLinkOnControl();
            if (!enabled) {
                return reply(buildStatus(false, false, MODE_UNSUPPORTED, CONNECTION_UNSUPPORTED, false), null);
            }
            throw new BridgeException("UNSUPPORTED", "not-sent", "当前设备不支持剪贴板同步");
        }
        BotHostClient.ClipboardCredentials creds = credentialsProvider.current();
        if (creds == null) {
            stopActiveLinkOnControl();
            if (!enabled) {
                return reply(buildStatus(false, false, MODE_MANUAL, CONNECTION_NOT_PAIRED, false), null);
            }
            throw new BridgeException("NOT_PAIRED", "not-sent", "请先连接中心");
        }
        if (!enabled) {
            // Immediately fence callbacks and pending writes even before persistence finishes.
            stopActiveLinkOnControl();
        } else {
            nextAdapterAttemptAtMs = 0L;
        }
        ClipboardSyncStorage.State existing;
        try {
            existing = storage.readForBinding(creds.binding);
        } catch (IOException unreadable) {
            stopActiveLinkOnControl();
            throw new BridgeException("STORAGE_ERROR", "not-sent", "无法读取剪贴板同步配置");
        }
        try {
            storage.saveForBinding(creds.binding, enabled, existing.groupCode, existing.backgroundAuthorized);
        } catch (IOException failed) {
            stopActiveLinkOnControl();
            throw new BridgeException("STORAGE_ERROR", "not-sent", "无法保存剪贴板同步配置");
        }
        JSONObject status = reconcileOnControl();
        return reply(status, null);
    }

    private JSONObject actionNewGroup() throws Exception {
        if (!nativeBridge.isSupported()) {
            stopActiveLinkOnControl();
            throw new BridgeException("UNSUPPORTED", "not-sent", "当前设备不支持剪贴板同步");
        }
        BotHostClient.ClipboardCredentials creds = credentialsProvider.current();
        if (creds == null) {
            stopActiveLinkOnControl();
            throw new BridgeException("NOT_PAIRED", "not-sent", "请先连接中心");
        }
        String generated = nativeBridge.generateGroupCode();
        if (generated == null || generated.isEmpty() || !nativeBridge.validGroupCode(generated)) {
            if (!nativeBridge.isSupported()) {
                throw new BridgeException("UNSUPPORTED", "not-sent", "当前设备不支持剪贴板同步");
            }
            throw new BridgeException("INTERNAL", "not-sent", "无法生成同步组码");
        }
        ClipboardSyncStorage.State existing = readStateForMutation(creds.binding);
        // Changing group always fences any older link immediately before persisting.
        stopActiveLinkOnControl();
        try {
            storage.saveForBinding(creds.binding, existing.enabled, generated, existing.backgroundAuthorized);
        } catch (IOException failed) {
            throw new BridgeException("STORAGE_ERROR", "not-sent", "无法保存同步组码");
        }
        nextAdapterAttemptAtMs = 0L;
        JSONObject status = reconcileOnControl();
        return reply(status, generated);
    }

    private JSONObject actionJoinGroup(String rawCode) throws Exception {
        if (!nativeBridge.isSupported()) {
            stopActiveLinkOnControl();
            throw new BridgeException("UNSUPPORTED", "not-sent", "当前设备不支持剪贴板同步");
        }
        BotHostClient.ClipboardCredentials creds = credentialsProvider.current();
        if (creds == null) {
            stopActiveLinkOnControl();
            throw new BridgeException("NOT_PAIRED", "not-sent", "请先连接中心");
        }
        String normalized = rawCode == null ? "" : rawCode.trim();
        if (normalized.isEmpty() || !nativeBridge.validGroupCode(normalized)) {
            if (!nativeBridge.isSupported()) {
                throw new BridgeException("UNSUPPORTED", "not-sent", "当前设备不支持剪贴板同步");
            }
            throw new BridgeException("INVALID_GROUP_CODE", "not-sent", "同步组码无效");
        }
        ClipboardSyncStorage.State existing = readStateForMutation(creds.binding);
        // Joining a group persists the code and preserves the independent switch (never implicitly turns on).
        stopActiveLinkOnControl();
        try {
            storage.saveForBinding(creds.binding, existing.enabled, normalized, existing.backgroundAuthorized);
        } catch (IOException failed) {
            throw new BridgeException("STORAGE_ERROR", "not-sent", "无法保存同步组码");
        }
        nextAdapterAttemptAtMs = 0L;
        JSONObject status = reconcileOnControl();
        return reply(status, null);
    }

    private JSONObject actionShowCode() throws Exception {
        if (!nativeBridge.isSupported()) {
            stopActiveLinkOnControl();
            throw new BridgeException("UNSUPPORTED", "not-sent", "当前设备不支持剪贴板同步");
        }
        BotHostClient.ClipboardCredentials creds = credentialsProvider.current();
        if (creds == null) {
            stopActiveLinkOnControl();
            throw new BridgeException("NOT_PAIRED", "not-sent", "请先连接中心");
        }
        ClipboardSyncStorage.State state;
        try {
            state = storage.readForBinding(creds.binding);
        } catch (IOException unreadable) {
            stopActiveLinkOnControl();
            throw new BridgeException("STORAGE_ERROR", "not-sent", "无法读取同步组码");
        }
        if (!state.isConfigured()) {
            throw new BridgeException("NOT_CONFIGURED", "not-sent", "尚未配置同步组码");
        }
        JSONObject status = reconcileOnControl();
        return reply(status, state.groupCode);
    }

    private JSONObject actionAuthorizeBackground() throws Exception {
        if (!nativeBridge.isSupported()) {
            stopActiveLinkOnControl();
            throw new BridgeException("UNSUPPORTED", "not-sent", "当前设备不支持剪贴板同步");
        }
        BotHostClient.ClipboardCredentials creds = credentialsProvider.current();
        if (creds == null) {
            stopActiveLinkOnControl();
            throw new BridgeException("NOT_PAIRED", "not-sent", "请先连接中心");
        }
        if (privilegedAdapter == null) {
            throw new BridgeException("UNSUPPORTED", "not-sent", "当前设备不支持后台自动同步");
        }
        // Verifies Shizuku is running and already granted (via foreground onboarding) without
        // requesting system permissions or registering a listener while off/offline.
        privilegedAdapter.checkAuthorizationPrerequisites();

        ClipboardSyncStorage.State existing;
        try {
            existing = storage.readForBinding(creds.binding);
        } catch (IOException unreadable) {
            throw new BridgeException("STORAGE_ERROR", "not-sent", "无法读取剪贴板同步配置");
        }
        try {
            storage.saveForBinding(creds.binding, existing.enabled, existing.groupCode, true);
        } catch (IOException failed) {
            throw new BridgeException("STORAGE_ERROR", "not-sent", "无法保存后台剪贴板授权");
        }
        nextAdapterAttemptAtMs = 0L;
        JSONObject status = reconcileOnControl();
        return reply(status, null);
    }

    private JSONObject actionRevokeBackground() throws Exception {
        stopPrivilegedAdapterOnControl();
        cancelOnlineWatch();
        if (!nativeBridge.isSupported()) {
            stopActiveLinkOnControl();
            return reply(buildStatus(false, false, MODE_UNSUPPORTED, CONNECTION_UNSUPPORTED, false), null);
        }
        BotHostClient.ClipboardCredentials creds = credentialsProvider.current();
        if (creds == null) {
            stopActiveLinkOnControl();
            return reply(buildStatus(false, false, MODE_MANUAL, CONNECTION_NOT_PAIRED, false), null);
        }
        ClipboardSyncStorage.State existing;
        try {
            existing = storage.readForBinding(creds.binding);
        } catch (IOException unreadable) {
            throw new BridgeException("STORAGE_ERROR", "not-sent", "无法读取剪贴板同步配置");
        }
        try {
            storage.saveForBinding(creds.binding, existing.enabled, existing.groupCode, false);
        } catch (IOException failed) {
            throw new BridgeException("STORAGE_ERROR", "not-sent", "无法移除后台剪贴板授权");
        }
        JSONObject status = reconcileOnControl();
        return reply(status, null);
    }

    private JSONObject actionSendNow(String text) throws Exception {
        if (!nativeBridge.isSupported()) {
            stopActiveLinkOnControl();
            throw new BridgeException("UNSUPPORTED", "not-sent", "当前设备不支持剪贴板同步");
        }
        BotHostClient.ClipboardCredentials creds = credentialsProvider.current();
        if (creds == null) {
            stopActiveLinkOnControl();
            throw new BridgeException("NOT_PAIRED", "not-sent", "请先连接中心");
        }
        if (!lifecycleOpen.getAsBoolean()) {
            stopActiveLinkOnControl();
            throw new BridgeException("CLOSED", "not-sent", "客户端未运行");
        }
        JSONObject status = reconcileOnControl();
        if (!status.optBoolean("enabled", false)) {
            throw new BridgeException("NOT_ENABLED", "not-sent", "剪贴板同步未开启");
        }
        if (!status.optBoolean("configured", false)) {
            throw new BridgeException("NOT_CONFIGURED", "not-sent", "尚未配置同步组码");
        }
        long handle;
        long epoch;
        synchronized (stateLock) {
            handle = activeHandle;
            epoch = linkEpoch;
            if (handle == 0L || !currentEnabled) {
                throw new BridgeException("NOT_ONLINE", "not-sent", "剪贴板同步未在线");
            }
        }
        long onlineGen = nativeBridge.onlineGeneration(handle);
        if (onlineGen == 0L) {
            throw new BridgeException("NOT_ONLINE", "not-sent", "剪贴板同步未在线");
        }
        // Recheck lifecycle, credentials, and epoch immediately before sending.
        BotHostClient.ClipboardCredentials freshCreds = credentialsProvider.current();
        if (!lifecycleOpen.getAsBoolean()
                || freshCreds == null
                || !freshCreds.linkAllowed
                || !creds.binding.bindingKey().equals(freshCreds.binding.bindingKey())
                || creds.generation != freshCreds.generation) {
            stopActiveLinkOnControl();
            throw new BridgeException("CANCELLED", "not-sent", "中心连接状态已变更");
        }
        synchronized (stateLock) {
            if (activeHandle != handle || linkEpoch != epoch || !currentEnabled) {
                throw new BridgeException("CANCELLED", "not-sent", "剪贴板同步状态已变更");
            }
        }
        boolean sent = nativeBridge.send(handle, onlineGen, text);
        if (!sent) {
            if (nativeBridge.onlineGeneration(handle) == 0L) {
                throw new BridgeException("NOT_ONLINE", "not-sent", "剪贴板同步未在线");
            }
            throw new BridgeException("SEND_FAILED", "unconfirmed", "剪贴板发送失败");
        }
        JSONObject updatedStatus = reconcileOnControl();
        return reply(updatedStatus, null);
    }

    private ClipboardSyncStorage.State readStateForMutation(ClipboardSyncStorage.Binding binding) {
        try {
            return storage.readForBinding(binding);
        } catch (IOException unreadable) {
            // Allow overwriting corrupted storage with a fresh group while failing closed.
            return ClipboardSyncStorage.State.empty();
        }
    }

    // ---------- Core reconcile & native handle lifecycle (controlWorker only) ----------

    private JSONObject reconcileOnControl() throws Exception {
        if (!nativeBridge.isSupported()) {
            stopActiveLinkOnControl();
            return buildStatus(false, false, MODE_UNSUPPORTED, CONNECTION_UNSUPPORTED, false);
        }
        BotHostClient.ClipboardCredentials creds = credentialsProvider.current();
        if (creds == null) {
            stopActiveLinkOnControl();
            return buildStatus(false, false, MODE_MANUAL, CONNECTION_NOT_PAIRED, false);
        }
        ClipboardSyncStorage.State state;
        try {
            state = storage.readForBinding(creds.binding);
        } catch (IOException unreadable) {
            stopActiveLinkOnControl();
            throw new BridgeException("STORAGE_ERROR", "not-sent", "无法读取剪贴板同步配置");
        }

        boolean configured = state.isConfigured();
        boolean enabled = state.enabled;
        boolean backgroundAuthorized = state.backgroundAuthorized;
        boolean serviceActive = lifecycleOpen.getAsBoolean();
        boolean shouldRun = serviceActive && creds.linkAllowed && enabled && configured;

        boolean alreadyMatches;
        synchronized (stateLock) {
            currentEnabled = enabled;
            currentBackgroundAuthorized = backgroundAuthorized;
            alreadyMatches = activeHandle != 0L
                    && creds.binding.bindingKey().equals(activeBindingKey)
                    && creds.generation == activeCredentialGeneration
                    && state.groupCode != null
                    && state.groupCode.equals(activeGroupCode);
        }

        if (!shouldRun) {
            stopActiveLinkOnControl();
            String connection;
            if (!enabled || !configured || !serviceActive) {
                connection = CONNECTION_OFF;
            } else if (creds.blockedErrorCode != null) {
                connection = mapBlockedCenterError(creds.blockedErrorCode);
            } else if (creds.connecting) {
                connection = CONNECTION_CONNECTING;
            } else {
                connection = CONNECTION_OFFLINE;
            }
            return buildStatus(enabled, configured, MODE_MANUAL, connection, backgroundAuthorized);
        }

        if (!alreadyMatches) {
            stopActiveLinkOnControl();
            startLinkOnControl(creds, state.groupCode, backgroundAuthorized);
        }

        long liveHandle;
        long liveEpoch;
        String liveBindingKey;
        long liveCredGen;
        synchronized (stateLock) {
            liveHandle = activeHandle;
            liveEpoch = linkEpoch;
            liveBindingKey = activeBindingKey;
            liveCredGen = activeCredentialGeneration;
        }
        if (!nativeBridge.isSupported()) {
            stopActiveLinkOnControl();
            return buildStatus(enabled, configured, MODE_UNSUPPORTED, CONNECTION_UNSUPPORTED, false);
        }
        String connection = liveHandle != 0L
                ? normalizeNativeStatus(nativeBridge.status(liveHandle))
                : CONNECTION_OFFLINE;
        long onlineGen = (liveHandle != 0L && liveBindingKey != null)
                ? readOnlineGenerationIfCurrent(liveEpoch, liveHandle, liveBindingKey, liveCredGen)
                : 0L;
        boolean activeOnline = liveHandle != 0L
                && CONNECTION_ONLINE.equals(connection)
                && onlineGen > 0L;

        boolean listenerActive = reconcilePrivilegedAdapterOnControl(
                backgroundAuthorized, activeOnline, liveEpoch, liveHandle, liveBindingKey, liveCredGen, onlineGen);

        String mode;
        if (CONNECTION_UNSUPPORTED.equals(connection) && !nativeBridge.isSupported()) {
            mode = MODE_UNSUPPORTED;
        } else if (listenerActive) {
            mode = MODE_AUTOMATIC;
        } else {
            mode = MODE_MANUAL;
        }
        return buildStatus(enabled, configured, mode, connection, backgroundAuthorized);
    }

    private void startLinkOnControl(BotHostClient.ClipboardCredentials creds,
                                    String groupCode,
                                    boolean backgroundAuthorized) {
        long myEpoch;
        synchronized (stateLock) {
            myEpoch = ++linkEpoch;
            pendingIncoming = null;
            pendingPrivilegedCapture = null;
            observedLinkEpoch = 0L;
            observedOnlineGeneration = 0L;
            currentEnabled = true;
            currentBackgroundAuthorized = backgroundAuthorized;
        }
        String expectedBindingKey = creds.binding.bindingKey();
        long expectedCredGen = creds.generation;
        long handle = nativeBridge.start(
                creds.origin,
                creds.deviceId,
                creds.deviceToken,
                creds.caPem,
                groupCode,
                (nativeGeneration, text) -> onNativeText(
                        myEpoch, expectedBindingKey, expectedCredGen, nativeGeneration, text));
        if (handle == 0L) {
            return;
        }
        BotHostClient.ClipboardCredentials freshCreds = credentialsProvider.current();
        boolean stillValid = lifecycleOpen.getAsBoolean()
                && freshCreds != null
                && freshCreds.linkAllowed
                && expectedBindingKey.equals(freshCreds.binding.bindingKey())
                && expectedCredGen == freshCreds.generation;
        boolean installed = false;
        synchronized (stateLock) {
            if (stillValid && linkEpoch == myEpoch && currentEnabled) {
                activeHandle = handle;
                activeBindingKey = expectedBindingKey;
                activeCredentialGeneration = expectedCredGen;
                activeGroupCode = groupCode;
                installed = true;
            }
        }
        if (!installed) {
            nativeBridge.stop(handle);
        }
    }

    private boolean reconcilePrivilegedAdapterOnControl(boolean backgroundAuthorized,
                                                        boolean activeOnline,
                                                        long liveEpoch,
                                                        long liveHandle,
                                                        String liveBindingKey,
                                                        long liveCredGen,
                                                        long onlineGen) {
        if (privilegedAdapter == null || !backgroundAuthorized || liveHandle == 0L || liveBindingKey == null) {
            stopPrivilegedAdapterOnControl();
            cancelOnlineWatch();
            return false;
        }
        if (!activeOnline || onlineGen <= 0L) {
            // Never register a listener or keep Shizuku bound while not active-online.
            stopPrivilegedAdapterOnControl();
            scheduleOnlineWatch(WATCH_CONNECTING_INTERVAL_MS);
            return false;
        }

        boolean alreadyArmedForExactEpoch;
        synchronized (stateLock) {
            alreadyArmedForExactEpoch = observedLinkEpoch == liveEpoch
                    && observedOnlineGeneration == onlineGen
                    && activeHandle == liveHandle
                    && currentEnabled
                    && currentBackgroundAuthorized
                    && liveBindingKey.equals(activeBindingKey)
                    && liveCredGen == activeCredentialGeneration;
        }
        if (alreadyArmedForExactEpoch && privilegedAdapter.isListenerActive()) {
            scheduleOnlineWatch(WATCH_ONLINE_INTERVAL_MS);
            return true;
        }

        // Stop any stale listener (e.g., older onlineGeneration before reconnect, or dead binder).
        stopPrivilegedAdapterOnControl();

        long now = monotonicMillis();
        if (now < nextAdapterAttemptAtMs) {
            scheduleOnlineWatch(Math.max(WATCH_CONNECTING_INTERVAL_MS, nextAdapterAttemptAtMs - now));
            return false;
        }

        if (!isExactOnlineEpochCurrent(liveEpoch, liveHandle, liveBindingKey, liveCredGen, onlineGen)) {
            scheduleOnlineWatch(WATCH_CONNECTING_INTERVAL_MS);
            return false;
        }

        boolean started;
        try {
            started = privilegedAdapter.startListening(
                    () -> onPrivilegedClipboardChanged(liveEpoch, liveHandle, liveBindingKey, liveCredGen, onlineGen),
                    () -> onPrivilegedListenerUnavailable(liveEpoch, onlineGen));
        } catch (Throwable failure) {
            started = false;
        }

        if (!started || !privilegedAdapter.isListenerActive()) {
            stopPrivilegedAdapterOnControl();
            nextAdapterAttemptAtMs = monotonicMillis() + ADAPTER_RETRY_BACKOFF_MS;
            scheduleOnlineWatch(ADAPTER_RETRY_BACKOFF_MS);
            return false;
        }

        boolean stillCurrent = isExactOnlineEpochCurrent(liveEpoch, liveHandle, liveBindingKey, liveCredGen, onlineGen);
        boolean installed = false;
        if (stillCurrent) {
            synchronized (stateLock) {
                if (linkEpoch == liveEpoch
                        && activeHandle == liveHandle
                        && currentEnabled
                        && currentBackgroundAuthorized
                        && liveBindingKey.equals(activeBindingKey)
                        && liveCredGen == activeCredentialGeneration) {
                    observedLinkEpoch = liveEpoch;
                    observedOnlineGeneration = onlineGen;
                    installed = true;
                }
            }
        }
        if (!installed) {
            stopPrivilegedAdapterOnControl();
            return false;
        }
        nextAdapterAttemptAtMs = 0L;
        scheduleOnlineWatch(WATCH_ONLINE_INTERVAL_MS);
        return true;
    }

    private boolean isExactOnlineEpochCurrent(long expectedEpoch, long expectedHandle,
                                              String expectedBindingKey, long expectedCredGen,
                                              long expectedOnlineGen) {
        if (expectedHandle == 0L || expectedOnlineGen <= 0L || expectedBindingKey == null) {
            return false;
        }
        if (!lifecycleOpen.getAsBoolean()) {
            return false;
        }
        BotHostClient.ClipboardCredentials freshCreds = credentialsProvider.current();
        if (freshCreds == null
                || !freshCreds.linkAllowed
                || !expectedBindingKey.equals(freshCreds.binding.bindingKey())
                || expectedCredGen != freshCreds.generation) {
            return false;
        }
        long liveGen = readOnlineGenerationIfCurrent(expectedEpoch, expectedHandle, expectedBindingKey, expectedCredGen);
        if (liveGen == 0L || liveGen != expectedOnlineGen) {
            return false;
        }
        return CONNECTION_ONLINE.equals(normalizeNativeStatus(nativeBridge.status(expectedHandle)));
    }

    private void onPrivilegedClipboardChanged(long expectedEpoch, long expectedHandle,
                                              String expectedBindingKey, long expectedCredGen,
                                              long expectedOnlineGen) {
        if (privilegedAdapter == null || expectedHandle == 0L || expectedOnlineGen <= 0L
                || expectedBindingKey == null || !lifecycleOpen.getAsBoolean()) {
            return;
        }
        boolean schedule = false;
        synchronized (stateLock) {
            if (expectedEpoch != linkEpoch
                    || activeHandle != expectedHandle
                    || !currentEnabled
                    || !currentBackgroundAuthorized
                    || !expectedBindingKey.equals(activeBindingKey)
                    || expectedCredGen != activeCredentialGeneration
                    || observedLinkEpoch != expectedEpoch
                    || observedOnlineGeneration != expectedOnlineGen) {
                return;
            }
            // Bounded to 1 latest pending capture for this exact native link epoch.
            pendingPrivilegedCapture = new PendingCapture(
                    expectedEpoch, expectedHandle, expectedBindingKey, expectedCredGen, expectedOnlineGen);
            if (!privilegedCaptureScheduled) {
                privilegedCaptureScheduled = true;
                schedule = true;
            }
        }
        if (schedule) {
            controlWorker.execute(this::drainPrivilegedCapture);
        }
    }

    private void drainPrivilegedCapture() {
        PendingCapture pending;
        synchronized (stateLock) {
            privilegedCaptureScheduled = false;
            pending = pendingPrivilegedCapture;
            pendingPrivilegedCapture = null;
            if (pending == null) {
                return;
            }
            if (pending.linkEpoch != linkEpoch
                    || activeHandle != pending.handle
                    || !currentEnabled
                    || !currentBackgroundAuthorized
                    || !pending.bindingKey.equals(activeBindingKey)
                    || pending.credentialGeneration != activeCredentialGeneration
                    || observedLinkEpoch != pending.linkEpoch
                    || observedOnlineGeneration != pending.onlineGeneration) {
                return;
            }
        }
        if (privilegedAdapter == null || !privilegedAdapter.isListenerActive()) {
            reconcileQuietly();
            return;
        }
        // Validate exact native link epoch BEFORE issuing IPC read so stale notifications
        // never read or publish text after offline/reconnect/disable/revoke.
        if (!isExactOnlineEpochCurrent(
                pending.linkEpoch, pending.handle, pending.bindingKey,
                pending.credentialGeneration, pending.onlineGeneration)) {
            reconcileQuietly();
            return;
        }

        String text;
        try {
            text = privilegedAdapter.readSendableText();
        } catch (Throwable failure) {
            reconcileQuietly();
            return;
        }
        ClipReadResult checked = validatePlainText(text);
        if (!checked.ok) {
            return;
        }

        // Recheck exact epoch immediately before native send.
        if (!isExactOnlineEpochCurrent(
                pending.linkEpoch, pending.handle, pending.bindingKey,
                pending.credentialGeneration, pending.onlineGeneration)) {
            reconcileQuietly();
            return;
        }
        synchronized (stateLock) {
            if (pending.linkEpoch != linkEpoch
                    || activeHandle != pending.handle
                    || !currentEnabled
                    || !currentBackgroundAuthorized
                    || !pending.bindingKey.equals(activeBindingKey)
                    || pending.credentialGeneration != activeCredentialGeneration
                    || observedLinkEpoch != pending.linkEpoch
                    || observedOnlineGeneration != pending.onlineGeneration) {
                return;
            }
        }
        try {
            if (!nativeBridge.send(pending.handle, pending.onlineGeneration, checked.text)) {
                reconcileQuietly();
            }
        } catch (Throwable ignored) {
            // Automatic capture never logs plaintext or crashes on transient offline state.
        }
    }

    private void onPrivilegedListenerUnavailable(long expectedEpoch, long expectedOnlineGen) {
        boolean matched;
        synchronized (stateLock) {
            matched = observedLinkEpoch == expectedEpoch && observedOnlineGeneration == expectedOnlineGen;
            if (matched) {
                observedLinkEpoch = 0L;
                observedOnlineGeneration = 0L;
                pendingPrivilegedCapture = null;
            }
        }
        controlWorker.execute(() -> {
            if (matched) {
                nextAdapterAttemptAtMs = monotonicMillis() + ADAPTER_RETRY_BACKOFF_MS;
            }
            reconcileQuietly();
        });
    }

    private void scheduleOnlineWatch(long delayMs) {
        if (!(controlWorker instanceof ScheduledExecutorService)) {
            return;
        }
        ScheduledExecutorService scheduler = (ScheduledExecutorService) controlWorker;
        synchronized (watchLock) {
            if (onlineWatchFuture != null) {
                onlineWatchFuture.cancel(false);
                onlineWatchFuture = null;
            }
            if (scheduler.isShutdown()) {
                return;
            }
            onlineWatchFuture = scheduler.schedule(this::reconcileQuietly, delayMs, TimeUnit.MILLISECONDS);
        }
    }

    private void cancelOnlineWatch() {
        synchronized (watchLock) {
            if (onlineWatchFuture != null) {
                onlineWatchFuture.cancel(false);
                onlineWatchFuture = null;
            }
        }
    }

    private void stopPrivilegedAdapterOnControl() {
        detachPrivilegedObservationLocked();
        if (privilegedAdapter != null) {
            try {
                privilegedAdapter.stopListening();
            } catch (Throwable ignored) {
            }
        }
    }

    private void detachPrivilegedObservationLocked() {
        synchronized (stateLock) {
            observedLinkEpoch = 0L;
            observedOnlineGeneration = 0L;
            pendingPrivilegedCapture = null;
        }
    }

    private void cancelPrivilegedPending() {
        if (privilegedAdapter != null) {
            try {
                privilegedAdapter.cancelPending();
            } catch (Throwable ignored) {
            }
        }
    }

    private void stopActiveLinkOnControl() {
        long detached = detachActiveLinkLocked();
        cancelPrivilegedPending();
        stopDetachedHandle(detached);
    }

    /**
     * Immediately fences callbacks, clears any pending incoming OS write and privileged capture,
     * and detaches the active native handle under {@code stateLock}. Caller MUST stop the returned
     * non-zero handle outside {@code stateLock}.
     */
    private long detachActiveLinkLocked() {
        long handleToStop;
        synchronized (stateLock) {
            ++linkEpoch;
            pendingIncoming = null;
            pendingPrivilegedCapture = null;
            observedLinkEpoch = 0L;
            observedOnlineGeneration = 0L;
            handleToStop = activeHandle;
            activeHandle = 0L;
            activeBindingKey = null;
            activeCredentialGeneration = -1L;
            activeGroupCode = null;
            currentEnabled = false;
            currentBackgroundAuthorized = false;
        }
        cancelOnlineWatch();
        return handleToStop;
    }

    private void stopDetachedHandle(long handle) {
        cancelOnlineWatch();
        stopPrivilegedAdapterOnControl();
        if (handle != 0L) {
            // Drain any in-flight onlineGeneration(handle) readers before freeing the native handle.
            handleCallLock.writeLock().lock();
            handleCallLock.writeLock().unlock();
            nativeBridge.stop(handle);
        }
    }

    private long readOnlineGenerationIfCurrent(long expectedEpoch, long expectedHandle,
                                               String expectedBindingKey, long expectedCredGen) {
        handleCallLock.readLock().lock();
        try {
            long handleToQuery;
            synchronized (stateLock) {
                if (expectedEpoch != linkEpoch
                        || activeHandle == 0L
                        || (expectedHandle != 0L && activeHandle != expectedHandle)
                        || !currentEnabled
                        || !expectedBindingKey.equals(activeBindingKey)
                        || expectedCredGen != activeCredentialGeneration) {
                    return 0L;
                }
                handleToQuery = activeHandle;
            }
            return nativeBridge.onlineGeneration(handleToQuery);
        } finally {
            handleCallLock.readLock().unlock();
        }
    }

    private void invalidateEpochAndScheduleStop(long expectedEpoch) {
        long detached = 0L;
        synchronized (stateLock) {
            if (linkEpoch != expectedEpoch) {
                return;
            }
            ++linkEpoch;
            pendingIncoming = null;
            pendingPrivilegedCapture = null;
            observedLinkEpoch = 0L;
            observedOnlineGeneration = 0L;
            detached = activeHandle;
            activeHandle = 0L;
            activeBindingKey = null;
            activeCredentialGeneration = -1L;
            activeGroupCode = null;
            currentEnabled = false;
            currentBackgroundAuthorized = false;
        }
        cancelOnlineWatch();
        cancelPrivilegedPending();
        long handleToStop = detached;
        if (handleToStop != 0L || privilegedAdapter != null) {
            controlWorker.execute(() -> stopDetachedHandle(handleToStop));
        }
    }

    // ---------- Incoming native callback & bounded 1-slot main-thread OS clipboard writer ----------

    private void onNativeText(long myEpoch, String expectedBindingKey, long expectedCredGen,
                              long nativeGeneration, String text) {
        if (nativeGeneration == 0L || text == null) {
            return;
        }
        long handle;
        synchronized (stateLock) {
            if (myEpoch != linkEpoch
                    || activeHandle == 0L
                    || !currentEnabled
                    || !expectedBindingKey.equals(activeBindingKey)
                    || expectedCredGen != activeCredentialGeneration) {
                return;
            }
            handle = activeHandle;
        }
        if (!lifecycleOpen.getAsBoolean()) {
            invalidateEpochAndScheduleStop(myEpoch);
            return;
        }
        BotHostClient.ClipboardCredentials freshCreds = credentialsProvider.current();
        if (freshCreds == null
                || !freshCreds.linkAllowed
                || !expectedBindingKey.equals(freshCreds.binding.bindingKey())
                || expectedCredGen != freshCreds.generation) {
            invalidateEpochAndScheduleStop(myEpoch);
            return;
        }
        long liveGen = readOnlineGenerationIfCurrent(myEpoch, handle, expectedBindingKey, expectedCredGen);
        if (liveGen == 0L || liveGen != nativeGeneration) {
            return;
        }
        boolean schedule = false;
        synchronized (stateLock) {
            if (myEpoch != linkEpoch
                    || activeHandle != handle
                    || !currentEnabled
                    || !expectedBindingKey.equals(activeBindingKey)
                    || expectedCredGen != activeCredentialGeneration) {
                return;
            }
            // Bounded to one latest incoming pending OS write: overwrite any older queued write.
            pendingIncoming = new PendingWrite(
                    myEpoch, handle, expectedBindingKey, expectedCredGen, nativeGeneration, text);
            if (!incomingWriteScheduled) {
                incomingWriteScheduled = true;
                schedule = true;
            }
        }
        if (schedule) {
            mainExecutor.execute(this::drainIncomingWrite);
        }
    }

    private void drainIncomingWrite() {
        PendingWrite pending;
        synchronized (stateLock) {
            incomingWriteScheduled = false;
            pending = pendingIncoming;
            pendingIncoming = null;
            if (pending == null) {
                return;
            }
            if (pending.linkEpoch != linkEpoch
                    || activeHandle != pending.handle
                    || !currentEnabled
                    || !pending.bindingKey.equals(activeBindingKey)
                    || pending.credentialGeneration != activeCredentialGeneration) {
                return;
            }
        }
        if (!lifecycleOpen.getAsBoolean()) {
            invalidateEpochAndScheduleStop(pending.linkEpoch);
            return;
        }
        BotHostClient.ClipboardCredentials freshCreds = credentialsProvider.current();
        if (freshCreds == null
                || !freshCreds.linkAllowed
                || !pending.bindingKey.equals(freshCreds.binding.bindingKey())
                || pending.credentialGeneration != freshCreds.generation) {
            invalidateEpochAndScheduleStop(pending.linkEpoch);
            return;
        }
        long liveGen = readOnlineGenerationIfCurrent(
                pending.linkEpoch, pending.handle, pending.bindingKey, pending.credentialGeneration);
        if (liveGen == 0L || liveGen != pending.nativeGeneration) {
            return;
        }
        synchronized (stateLock) {
            if (pending.linkEpoch != linkEpoch
                    || activeHandle != pending.handle
                    || !currentEnabled
                    || !pending.bindingKey.equals(activeBindingKey)
                    || pending.credentialGeneration != activeCredentialGeneration) {
                return;
            }
        }
        clipboardWriter.writeIncomingText(pending.text);
    }

    // ---------- Helpers ----------

    private static long monotonicMillis() {
        return System.nanoTime() / 1_000_000L;
    }

    private static String mapBlockedCenterError(String code) {
        if ("CERTIFICATE_ERROR".equals(code)) {
            return CONNECTION_CERTIFICATE_ERROR;
        }
        if ("UNAUTHORIZED".equals(code) || "FORBIDDEN".equals(code) || "REVOKED".equals(code)) {
            return CONNECTION_UNAUTHORIZED;
        }
        return CONNECTION_OFFLINE;
    }

    private static JSONObject buildStatus(boolean enabled, boolean configured, String mode,
                                          String connection, boolean backgroundAuthorized) {
        try {
            return new JSONObject()
                    .put("enabled", enabled)
                    .put("configured", configured)
                    .put("mode", mode)
                    .put("connection", connection)
                    .put("backgroundAuthorized", backgroundAuthorized);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static JSONObject reply(JSONObject status, String code) {
        try {
            JSONObject result = new JSONObject().put("status", status);
            if (code != null && !code.isEmpty()) {
                result.put("code", code);
            }
            return result;
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static CompletableFuture<JSONObject> failed(Throwable failure) {
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        future.completeExceptionally(failure);
        return future;
    }
}
