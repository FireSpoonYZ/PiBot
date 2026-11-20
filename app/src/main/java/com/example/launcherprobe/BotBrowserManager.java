package com.example.launcherprobe;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;

/**
 * Android 本机 Bot 浏览器会话管理器（运行在默认 Host 进程，不依赖 Shower，不启动 Electron）。
 *
 * 隔离与安全设计：
 * - 独立进程 WebView 数据目录后缀 "bot-browser"（与 :tauri_ui 的 "tauri-ui" 完全物理隔离）；
 * - 严格要求 WebViewFeature.MULTI_PROFILE，每 Bot 独占非默认 Profile（"bot-<sha256>"），
 *   不支持时诚实回报 unavailable 与外部浏览器引导，绝不静默复用 Default profile；
 * - 零 addJavascriptInterface 暴露，所有页面读取与受限动作仅走单向固定参数化模板；
 * - 敏感页/OAuth/Secret 硬阻断，输入前复核 pageId、revision 与敏感态；
 * - 受控资源上限（最多 4 个并发 Bot、每 Bot 最多 6 个标签页、15 分钟空闲回收、Host 关闭全量销毁）。
 */
final class BotBrowserManager {
    private static final String PROCESS_DATA_DIR_SUFFIX = "bot-browser";
    private static final long IDLE_SESSION_TTL_MS = 15L * 60L * 1000L;
    private static final long MAIN_THREAD_TIMEOUT_MS = 12_000L;
    private static final long EVAL_JS_TIMEOUT_MS = 10_000L;
    private static final int[] JPEG_QUALITIES = {80, 66, 52, 38, 24};
    private static final AtomicBoolean DATA_DIR_SUFFIX_ATTEMPTED = new AtomicBoolean(false);

    interface TabHandle {
        int viewportWidth();
        int viewportHeight();
        boolean canGoBack();
        boolean canGoForward();
    }

    interface TabCallbacks {
        void onNavigationCommit(String url, BotBrowserPolicy.Sensitivity urlSensitivity, String reason, boolean loading);
        void onPageFinished(String url);
        void onTitleChanged(String title);
        void onBlockedExternalNavigation(String blockedReason);
        void onDownloadBlocked();
        void onRenderProcessCrashed();
    }

    static final class Availability {
        final boolean available;
        final boolean canStreamInteract;
        final String profileIsolation;
        final String reason;

        Availability(boolean available, boolean canStreamInteract, String profileIsolation, String reason) {
            this.available = available;
            this.canStreamInteract = canStreamInteract;
            this.profileIsolation = profileIsolation;
            this.reason = reason;
        }

        static Availability supported() {
            return new Availability(true, true, "webview-multi-profile", null);
        }

        static Availability unsupported(String reason) {
            return new Availability(false, false, "unavailable", reason);
        }
    }

    static final class FrameCapture {
        final String mimeType;
        final String base64Data;
        final int sourceWidth;
        final int sourceHeight;
        final int imageWidth;
        final int imageHeight;

        FrameCapture(String mimeType, String base64Data, int sourceWidth, int sourceHeight,
                int imageWidth, int imageHeight) {
            this.mimeType = mimeType;
            this.base64Data = base64Data;
            this.sourceWidth = sourceWidth;
            this.sourceHeight = sourceHeight;
            this.imageWidth = imageWidth;
            this.imageHeight = imageHeight;
        }
    }

    interface Backend {
        Availability probeAvailability(BooleanSupplier cancelled) throws BotBrowserBridge.Failure;

        TabHandle createTab(String profileName, int width, int height, TabCallbacks callbacks,
                BooleanSupplier cancelled) throws BotBrowserBridge.Failure;

        void loadUrl(TabHandle tab, String url, BooleanSupplier cancelled) throws BotBrowserBridge.Failure;

        boolean goBack(TabHandle tab, BooleanSupplier cancelled) throws BotBrowserBridge.Failure;

        boolean goForward(TabHandle tab, BooleanSupplier cancelled) throws BotBrowserBridge.Failure;

        void reload(TabHandle tab, BooleanSupplier cancelled) throws BotBrowserBridge.Failure;

        FrameCapture captureFrame(TabHandle tab, int maxWidth, int maxHeight, int maxBytes,
                String preferredMimeType, BooleanSupplier cancelled) throws BotBrowserBridge.Failure;

        JSONObject snapshotDom(TabHandle tab, String snapshotToken, String source,
                BooleanSupplier cancelled) throws BotBrowserBridge.Failure;

        JSONObject actDom(TabHandle tab, String snapshotToken, String source, String currentUrl,
                JSONObject act, BooleanSupplier cancelled) throws BotBrowserBridge.Failure;

        void dispatchHumanInput(TabHandle tab, JSONObject event, BooleanSupplier cancelled)
                throws BotBrowserBridge.Failure;

        void destroyTab(TabHandle tab);
    }

    interface Clock {
        long nowMs();
    }

    private static final class SnapshotElementMeta {
        final String tag;
        final String type;
        final String autocomplete;
        final String label;

        SnapshotElementMeta(String tag, String type, String autocomplete, String label) {
            this.tag = tag;
            this.type = type;
            this.autocomplete = autocomplete;
            this.label = label;
        }
    }

    private static final class TabState {
        final String id;
        final TabHandle handle;
        volatile String url = "about:blank";
        volatile String title = "";
        volatile boolean loading = false;
        volatile boolean crashed = false;
        volatile long docGeneration = 1L;
        volatile BotBrowserPolicy.Sensitivity urlSensitivity = BotBrowserPolicy.Sensitivity.NORMAL;
        volatile String urlSensitivityReason = null;
        volatile BotBrowserPolicy.DomSensitivity domSensitivity =
                new BotBrowserPolicy.DomSensitivity(BotBrowserPolicy.Sensitivity.NORMAL, null, false);
        volatile String lastBlockedExternalReason = null;
        volatile boolean downloadBlocked = false;
        volatile String snapshotToken = null;
        final Map<String, SnapshotElementMeta> snapshotElements = new HashMap<>();

        TabState(String id, TabHandle handle) {
            this.id = id;
            this.handle = handle;
        }

        BotBrowserPolicy.Sensitivity effectiveSensitivity() {
            BotBrowserPolicy.Sensitivity dom = domSensitivity.sensitivity;
            if (urlSensitivity.ordinal() >= dom.ordinal()) return urlSensitivity;
            return dom;
        }

        String effectiveSensitivityReason() {
            if (urlSensitivity.ordinal() >= domSensitivity.sensitivity.ordinal()) {
                return urlSensitivityReason != null ? urlSensitivityReason : domSensitivity.reason;
            }
            return domSensitivity.reason != null ? domSensitivity.reason : urlSensitivityReason;
        }

        boolean hasPolicyConsent() {
            return domSensitivity.hasPolicyConsent
                    || effectiveSensitivity() == BotBrowserPolicy.Sensitivity.POLICY_CONSENT;
        }
    }

    private static final class BotSession {
        final String ownerKey;
        final String profileName;
        final String sessionId;
        final ReentrantLock lock = new ReentrantLock();
        final LinkedHashMap<String, TabState> tabs = new LinkedHashMap<>();
        String activePageId;
        final AtomicLong revision = new AtomicLong(0L);
        final AtomicLong frameSeq = new AtomicLong(0L);
        volatile long lastActiveAtMs;
        boolean released = false;

        BotSession(String ownerKey, String profileName, long nowMs) {
            this.ownerKey = ownerKey;
            this.profileName = profileName;
            this.sessionId = UUID.randomUUID().toString();
            this.lastActiveAtMs = nowMs;
        }
    }

    private final Backend backend;
    private final Clock clock;
    private final Object stateLock = new Object();
    private final Map<String, BotSession> sessions = new LinkedHashMap<>();
    private final AtomicBoolean closed = new AtomicBoolean(false);

    BotBrowserManager(Context context) {
        this(new AndroidWebViewBackend(context.getApplicationContext()), System::currentTimeMillis);
    }

    BotBrowserManager(Backend backend, Clock clock) {
        this.backend = backend;
        this.clock = clock;
    }

    /** 非创建式状态探测：不打开标签页，不创建 WebView，仅探测平台多 Profile 支持与当前 Bot 会话。 */
    JSONObject status(String deviceId, String botId, String source, BooleanSupplier cancelled)
            throws BotBrowserBridge.Failure, JSONException {
        ensureOpen();
        reapIdleSessions();
        Availability availability = backend.probeAvailability(cancelled);
        String ownerKey = BotBrowserPolicy.ownerKey(deviceId, botId);
        BotSession session;
        synchronized (stateLock) {
            session = sessions.get(ownerKey);
        }
        if (session == null) {
            return buildStatusDto(availability, null, source);
        }
        session.lock.lock();
        try {
            if (session.released) {
                return buildStatusDto(availability, null, source);
            }
            return buildStatusDto(availability, session, source);
        } finally {
            session.lock.unlock();
        }
    }

    JSONObject open(String deviceId, String botId, String source, JSONObject arguments,
            BooleanSupplier cancelled) throws BotBrowserBridge.Failure, JSONException {
        ensureOpen();
        reapIdleSessions();
        Availability availability = requireAvailable(cancelled);
        String rawUrl = arguments.optString("url", "").trim();
        BotBrowserPolicy.UrlCheck urlCheck = rawUrl.isEmpty()
                ? new BotBrowserPolicy.UrlCheck("about:blank", BotBrowserPolicy.Sensitivity.NORMAL, null)
                : BotBrowserPolicy.validateNavigationUrl(rawUrl);

        if (urlCheck.sensitivity.blocksWebViewNavigation()) {
            throw new BotBrowserBridge.Failure("BROWSER_SENSITIVE_BLOCKED",
                    "Google 账号登录或 OAuth 授权必须使用系统浏览器，禁止在 Bot WebView 中打开");
        }

        BotSession session = getOrCreateSession(deviceId, botId);
        session.lock.lock();
        try {
            ensureOpen();
            if (session.released) {
                throw new BotBrowserBridge.Failure("BROWSER_UNAVAILABLE", "浏览器会话已释放");
            }
            if (session.tabs.size() >= BotBrowserPolicy.MAX_TABS_PER_BOT) {
                throw new BotBrowserBridge.Failure("BROWSER_TAB_LIMIT",
                        "单个 Bot 最多同时打开 " + BotBrowserPolicy.MAX_TABS_PER_BOT + " 个标签页");
            }
            int width = clampInt(arguments.optInt("width", BotBrowserPolicy.DEFAULT_VIEWPORT_WIDTH),
                    BotBrowserPolicy.MIN_VIEWPORT_DIM, BotBrowserPolicy.MAX_FRAME_WIDTH);
            int height = clampInt(arguments.optInt("height", BotBrowserPolicy.DEFAULT_VIEWPORT_HEIGHT),
                    BotBrowserPolicy.MIN_VIEWPORT_DIM, BotBrowserPolicy.MAX_FRAME_HEIGHT);

            String pageId = "p-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            AtomicReference<TabState> tabRef = new AtomicReference<>();
            TabCallbacks callbacks = createCallbacks(session, tabRef);
            TabHandle handle = backend.createTab(session.profileName, width, height, callbacks, cancelled);
            TabState tab = new TabState(pageId, handle);
            tab.url = urlCheck.canonicalUrl;
            tab.urlSensitivity = urlCheck.sensitivity;
            tab.urlSensitivityReason = urlCheck.reason;
            tabRef.set(tab);

            session.tabs.put(pageId, tab);
            session.activePageId = pageId;
            session.revision.incrementAndGet();
            session.lastActiveAtMs = clock.nowMs();

            if (!"about:blank".equals(urlCheck.canonicalUrl)) {
                tab.loading = true;
                backend.loadUrl(handle, urlCheck.canonicalUrl, cancelled);
            }
            return buildStatusDto(availability, session, source);
        } finally {
            session.lock.unlock();
        }
    }

    JSONObject navigate(String deviceId, String botId, String source, JSONObject arguments,
            BooleanSupplier cancelled) throws BotBrowserBridge.Failure, JSONException {
        ensureOpen();
        Availability availability = requireAvailable(cancelled);
        BotBrowserPolicy.UrlCheck urlCheck = BotBrowserPolicy.validateNavigationUrl(arguments.optString("url", ""));
        if (urlCheck.sensitivity.blocksWebViewNavigation()) {
            throw new BotBrowserBridge.Failure("BROWSER_SENSITIVE_BLOCKED",
                    "Google 账号登录或 OAuth 授权必须使用系统浏览器，禁止在 Bot WebView 中打开");
        }
        BotSession session = requireSession(deviceId, botId);
        session.lock.lock();
        try {
            TabState tab = resolveTargetTab(session, arguments);
            verifyOptionalRevision(session, arguments);
            tab.url = urlCheck.canonicalUrl;
            tab.urlSensitivity = urlCheck.sensitivity;
            tab.urlSensitivityReason = urlCheck.reason;
            tab.domSensitivity = new BotBrowserPolicy.DomSensitivity(
                    BotBrowserPolicy.Sensitivity.NORMAL, null, false);
            tab.lastBlockedExternalReason = null;
            tab.downloadBlocked = false;
            tab.snapshotToken = null;
            tab.snapshotElements.clear();
            tab.docGeneration++;
            tab.loading = !"about:blank".equals(urlCheck.canonicalUrl);
            session.activePageId = tab.id;
            session.revision.incrementAndGet();
            session.lastActiveAtMs = clock.nowMs();
            backend.loadUrl(tab.handle, urlCheck.canonicalUrl, cancelled);
            return buildStatusDto(availability, session, source);
        } finally {
            session.lock.unlock();
        }
    }

    JSONObject history(String deviceId, String botId, String source, JSONObject arguments,
            int direction, BooleanSupplier cancelled) throws BotBrowserBridge.Failure, JSONException {
        ensureOpen();
        Availability availability = requireAvailable(cancelled);
        BotSession session = requireSession(deviceId, botId);
        session.lock.lock();
        try {
            TabState tab = resolveTargetTab(session, arguments);
            verifyOptionalRevision(session, arguments);
            boolean moved = direction < 0
                    ? backend.goBack(tab.handle, cancelled)
                    : backend.goForward(tab.handle, cancelled);
            if (moved) {
                tab.docGeneration++;
                tab.snapshotToken = null;
                tab.snapshotElements.clear();
                session.revision.incrementAndGet();
            }
            session.lastActiveAtMs = clock.nowMs();
            return buildStatusDto(availability, session, source);
        } finally {
            session.lock.unlock();
        }
    }

    JSONObject reload(String deviceId, String botId, String source, JSONObject arguments,
            BooleanSupplier cancelled) throws BotBrowserBridge.Failure, JSONException {
        ensureOpen();
        Availability availability = requireAvailable(cancelled);
        BotSession session = requireSession(deviceId, botId);
        session.lock.lock();
        try {
            TabState tab = resolveTargetTab(session, arguments);
            verifyOptionalRevision(session, arguments);
            tab.docGeneration++;
            tab.snapshotToken = null;
            tab.snapshotElements.clear();
            tab.loading = true;
            session.revision.incrementAndGet();
            session.lastActiveAtMs = clock.nowMs();
            backend.reload(tab.handle, cancelled);
            return buildStatusDto(availability, session, source);
        } finally {
            session.lock.unlock();
        }
    }

    JSONObject select(String deviceId, String botId, String source, JSONObject arguments,
            BooleanSupplier cancelled) throws BotBrowserBridge.Failure, JSONException {
        ensureOpen();
        Availability availability = requireAvailable(cancelled);
        String pageId = arguments.optString("pageId", "").trim();
        if (pageId.isEmpty()) {
            throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "select 需要指定 pageId");
        }
        BotSession session = requireSession(deviceId, botId);
        session.lock.lock();
        try {
            TabState tab = session.tabs.get(pageId);
            if (tab == null) {
                throw new BotBrowserBridge.Failure("BROWSER_PAGE_NOT_FOUND", "目标标签页不属于当前 Bot 或已关闭");
            }
            if (!pageId.equals(session.activePageId)) {
                session.activePageId = pageId;
                session.revision.incrementAndGet();
            }
            session.lastActiveAtMs = clock.nowMs();
            return buildStatusDto(availability, session, source);
        } finally {
            session.lock.unlock();
        }
    }

    JSONObject closeTab(String deviceId, String botId, String source, JSONObject arguments,
            BooleanSupplier cancelled) throws BotBrowserBridge.Failure, JSONException {
        ensureOpen();
        Availability availability = requireAvailable(cancelled);
        BotSession session = requireSession(deviceId, botId);
        session.lock.lock();
        try {
            TabState target = resolveTargetTab(session, arguments);
            session.tabs.remove(target.id);
            backend.destroyTab(target.handle);
            if (target.id.equals(session.activePageId)) {
                session.activePageId = session.tabs.isEmpty() ? null : lastTabId(session);
            }
            session.revision.incrementAndGet();
            session.lastActiveAtMs = clock.nowMs();
            return buildStatusDto(availability, session, source);
        } finally {
            session.lock.unlock();
        }
    }

    JSONObject frame(String deviceId, String botId, String source, JSONObject arguments,
            BooleanSupplier cancelled) throws BotBrowserBridge.Failure, JSONException {
        ensureOpen();
        requireAvailable(cancelled);
        BotSession session = requireSession(deviceId, botId);
        session.lock.lock();
        try {
            TabState tab = resolveTargetTab(session, arguments);
            if (tab.crashed) {
                throw new BotBrowserBridge.Failure("BROWSER_BACKEND_FAILED", "标签页渲染进程已异常退出，请重新打开");
            }
            BotBrowserPolicy.Sensitivity sensitivity = tab.effectiveSensitivity();
            if ("agent".equals(source) && sensitivity.blocksAgentObservation()) {
                throw new BotBrowserBridge.Failure("BROWSER_SENSITIVE_BLOCKED",
                        "敏感页面已开启隐私遮罩，禁止向 Bot 输出截图");
            }
            if (sensitivity.blocksHumanFrame()) {
                throw new BotBrowserBridge.Failure("BROWSER_SENSITIVE_BLOCKED",
                        "当前页面涉及登录/凭据/Client Secret，禁止截图传输，请转系统浏览器或私密控件");
            }

            JSONObject limits = arguments.optJSONObject("limits");
            int maxWidth = clampInt(
                    limits != null ? limits.optInt("maxWidth", BotBrowserPolicy.DEFAULT_VIEWPORT_WIDTH)
                            : BotBrowserPolicy.DEFAULT_VIEWPORT_WIDTH,
                    BotBrowserPolicy.MIN_VIEWPORT_DIM, BotBrowserPolicy.MAX_FRAME_WIDTH);
            int maxHeight = clampInt(
                    limits != null ? limits.optInt("maxHeight", BotBrowserPolicy.DEFAULT_VIEWPORT_HEIGHT)
                            : BotBrowserPolicy.DEFAULT_VIEWPORT_HEIGHT,
                    BotBrowserPolicy.MIN_VIEWPORT_DIM, BotBrowserPolicy.MAX_FRAME_HEIGHT);
            int maxBytes = clampInt(
                    limits != null ? limits.optInt("maxBytes", BotBrowserPolicy.MAX_FRAME_BASE64_BYTES)
                            : BotBrowserPolicy.MAX_FRAME_BASE64_BYTES,
                    16 * 1024, BotBrowserPolicy.MAX_FRAME_BASE64_BYTES);
            String preferredMime = limits != null ? limits.optString("mimeType", "image/jpeg") : "image/jpeg";
            if (!"image/jpeg".equals(preferredMime) && !"image/png".equals(preferredMime)) {
                preferredMime = "image/jpeg";
            }

            FrameCapture capture = backend.captureFrame(tab.handle, maxWidth, maxHeight, maxBytes,
                    preferredMime, cancelled);
            if (capture.base64Data.length() > maxBytes
                    || capture.base64Data.length() > BotBrowserPolicy.MAX_FRAME_BASE64_BYTES) {
                throw new BotBrowserBridge.Failure("BROWSER_FRAME_TOO_LARGE", "编码后的画面超出大小上限");
            }
            long seq = session.frameSeq.incrementAndGet();
            session.lastActiveAtMs = clock.nowMs();

            JSONObject out = new JSONObject();
            out.put("seq", seq);
            out.put("mimeType", capture.mimeType);
            out.put("data", capture.base64Data);
            out.put("width", capture.sourceWidth);
            out.put("height", capture.sourceHeight);
            out.put("imageWidth", capture.imageWidth);
            out.put("imageHeight", capture.imageHeight);
            out.put("revision", session.revision.get());
            out.put("pageId", tab.id);
            out.put("sensitive", sensitivity.isSensitive());
            if (tab.effectiveSensitivityReason() != null) {
                out.put("sensitiveReason", tab.effectiveSensitivityReason());
            }
            return out;
        } finally {
            session.lock.unlock();
        }
    }

    JSONObject snapshot(String deviceId, String botId, String source, JSONObject arguments,
            BooleanSupplier cancelled) throws BotBrowserBridge.Failure, JSONException {
        ensureOpen();
        requireAvailable(cancelled);
        BotSession session = requireSession(deviceId, botId);
        session.lock.lock();
        try {
            TabState tab = resolveTargetTab(session, arguments);
            verifyOptionalRevision(session, arguments);
            if (tab.crashed) {
                throw new BotBrowserBridge.Failure("BROWSER_BACKEND_FAILED", "标签页渲染进程已异常退出");
            }
            if ("agent".equals(source) && tab.effectiveSensitivity().blocksAgentObservation()) {
                throw new BotBrowserBridge.Failure("BROWSER_SENSITIVE_BLOCKED",
                        "敏感页面已启用隐私遮罩，禁止 Bot 读取页面内容");
            }

            String snapshotToken = UUID.randomUUID().toString();
            JSONObject raw = backend.snapshotDom(tab.handle, snapshotToken, source, cancelled);

            BotBrowserPolicy.DomSensitivity combined = BotBrowserPolicy.combineSensitivity(
                    tab.urlSensitivity,
                    tab.urlSensitivityReason,
                    raw.optBoolean("hasPasswordField", false),
                    raw.optBoolean("hasOtpField", false),
                    raw.optBoolean("hasSecretDialog", false),
                    raw.optBoolean("hasCardField", false),
                    raw.optBoolean("hasPolicyConsent", false));
            BotBrowserPolicy.Sensitivity previous = tab.effectiveSensitivity();
            tab.domSensitivity = combined;
            if (previous != tab.effectiveSensitivity()) {
                session.revision.incrementAndGet();
            }
            session.lastActiveAtMs = clock.nowMs();

            if ("agent".equals(source) && (raw.optBoolean("sensitiveBlocked", false)
                    || tab.effectiveSensitivity().blocksAgentObservation())) {
                tab.snapshotToken = null;
                tab.snapshotElements.clear();
                throw new BotBrowserBridge.Failure("BROWSER_SENSITIVE_BLOCKED",
                        "检测到密码/MFA/Client Secret 敏感边界，已阻断 Bot 读取页面");
            }

            tab.snapshotToken = snapshotToken;
            tab.snapshotElements.clear();
            JSONArray rawElements = raw.optJSONArray("interactive");
            JSONArray safeElements = new JSONArray();
            if (rawElements != null) {
                int count = Math.min(rawElements.length(), 80);
                for (int i = 0; i < count; i++) {
                    JSONObject item = rawElements.optJSONObject(i);
                    if (item == null) continue;
                    String ref = item.optString("ref", "");
                    if (!BotBrowserPolicy.isValidElementRef(ref)) continue;
                    String tag = item.optString("tag", "");
                    String type = item.optString("type", "");
                    String autocomplete = item.optString("autocomplete", "");
                    String label = concatLabels(item);
                    tab.snapshotElements.put(ref, new SnapshotElementMeta(tag, type, autocomplete, label));
                    safeElements.put(item);
                }
            }

            BotBrowserPolicy.Sensitivity eff = tab.effectiveSensitivity();
            JSONObject out = new JSONObject();
            out.put("pageId", tab.id);
            out.put("revision", session.revision.get());
            out.put("url", BotBrowserPolicy.sanitizeUrlForSource(tab.url, eff, source));
            out.put("title", eff.blocksAgentObservation() ? "" : tab.title);
            out.put("loading", tab.loading);
            out.put("canGoBack", tab.handle.canGoBack());
            out.put("canGoForward", tab.handle.canGoForward());
            out.put("sensitive", eff.isSensitive());
            if (tab.effectiveSensitivityReason() != null) {
                out.put("sensitiveReason", tab.effectiveSensitivityReason());
            }
            out.put("requiresHumanTakeover", tab.hasPolicyConsent());
            out.put("requiresSystemBrowser", eff.requiresSystemBrowser());
            out.put("interactive", safeElements);
            out.put("textSummary", raw.optString("textSummary", ""));
            out.put("truncated", raw.optBoolean("truncated", false));
            return out;
        } finally {
            session.lock.unlock();
        }
    }

    JSONObject act(String deviceId, String botId, String source, JSONObject arguments,
            BooleanSupplier cancelled) throws BotBrowserBridge.Failure, JSONException {
        ensureOpen();
        Availability availability = requireAvailable(cancelled);
        JSONObject act = arguments.optJSONObject("act");
        if (act == null) {
            throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "act 需要提供受限操作对象");
        }
        String kind = act.optString("kind", "");
        if (!BotBrowserPolicy.isAllowedActKind(kind)) {
            throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "不支持的受限 DOM 操作类型: " + kind);
        }

        BotSession session = requireSession(deviceId, botId);
        session.lock.lock();
        try {
            TabState tab = resolveTargetTab(session, arguments);
            verifyOptionalRevision(session, arguments);
            if (tab.crashed) {
                throw new BotBrowserBridge.Failure("BROWSER_BACKEND_FAILED", "标签页渲染进程已异常退出");
            }
            if ("agent".equals(source) && tab.effectiveSensitivity().blocksAgentObservation()) {
                throw new BotBrowserBridge.Failure("BROWSER_SENSITIVE_BLOCKED",
                        "敏感页面已启用隐私遮罩，禁止 Bot 执行页面动作");
            }

            if ("wait".equals(kind)) {
                int ms = clampInt(act.optInt("ms", 300), 0, BotBrowserPolicy.MAX_WAIT_MS);
                cancellableSleep(ms, cancelled);
                session.lastActiveAtMs = clock.nowMs();
                JSONObject out = buildStatusDto(availability, session, source);
                out.put("ok", true);
                return out;
            }

            String ref = act.optString("ref", "");
            boolean needsRef = "click".equals(kind) || "fill".equals(kind) || "type".equals(kind)
                    || "select".equals(kind) || "check".equals(kind) || "uncheck".equals(kind);
            if (needsRef) {
                if (!BotBrowserPolicy.isValidElementRef(ref)) {
                    throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "该 DOM 操作需要合法元素引用 ref");
                }
                if (tab.snapshotToken == null) {
                    throw new BotBrowserBridge.Failure("BROWSER_REVISION_MISMATCH",
                            "缺少有效页面快照，请先执行 snapshot 再操作");
                }
            } else if (!ref.isEmpty()) {
                if (!BotBrowserPolicy.isValidElementRef(ref)) {
                    throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "无效元素引用 ref");
                }
                if (tab.snapshotToken == null) {
                    throw new BotBrowserBridge.Failure("BROWSER_REVISION_MISMATCH",
                            "缺少有效页面快照，请先执行 snapshot 再操作");
                }
            }

            if ("agent".equals(source) && !ref.isEmpty()) {
                SnapshotElementMeta meta = tab.snapshotElements.get(ref);
                if (meta != null && BotBrowserPolicy.isSensitiveAgentControl(
                        tab.url, meta.tag, meta.type, meta.autocomplete, meta.label)) {
                    throw new BotBrowserBridge.Failure("BROWSER_SENSITIVE_BLOCKED",
                            "该控件属于条款勾选/OAuth 创建/密钥或密码边界，已停手等待人类接管");
                }
            }

            if ("fill".equals(kind) || "type".equals(kind)) {
                String text = act.optString("text", "");
                if (text.length() > BotBrowserPolicy.MAX_TEXT_LENGTH || text.indexOf('\0') >= 0) {
                    throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "文本长度超限或包含非法 NUL 字符");
                }
            } else if ("press".equals(kind)) {
                String key = act.optString("key", "");
                if (BotBrowserPolicy.resolveKeyCode(key) == null) {
                    throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "不支持的按键名");
                }
            }

            JSONObject result = backend.actDom(tab.handle, tab.snapshotToken, source, tab.url, act, cancelled);
            if (!result.optBoolean("ok", false)) {
                String code = result.optString("code", "BROWSER_BACKEND_FAILED");
                String msg = result.optString("message", "受限 DOM 操作未执行");
                if ("BROWSER_SENSITIVE_BLOCKED".equals(code)) {
                    tab.domSensitivity = new BotBrowserPolicy.DomSensitivity(
                            BotBrowserPolicy.Sensitivity.POLICY_CONSENT,
                            "sensitive_control_requires_human", true);
                    session.revision.incrementAndGet();
                }
                throw new BotBrowserBridge.Failure(code, msg);
            }

            session.revision.incrementAndGet();
            session.lastActiveAtMs = clock.nowMs();
            JSONObject out = buildStatusDto(availability, session, source);
            out.put("ok", true);
            return out;
        } finally {
            session.lock.unlock();
        }
    }

    /**
     * 人类接管真实输入：仅允许 source=="human"，在派发前复核 pageId、revision 与非阻断敏感态，
     * 直接向同一存活 WebView 注入触摸/键盘/滚轮/文本事件，不刷新、不新建标签页、不丢弃表单。
     */
    JSONObject input(String deviceId, String botId, JSONObject arguments, BooleanSupplier cancelled)
            throws BotBrowserBridge.Failure, JSONException {
        ensureOpen();
        Availability availability = requireAvailable(cancelled);
        JSONObject event = arguments.optJSONObject("event");
        validateHumanInputEvent(event);

        BotSession session = requireSession(deviceId, botId);
        session.lock.lock();
        try {
            TabState tab = resolveTargetTab(session, arguments);
            verifyOptionalRevision(session, arguments);
            if (tab.crashed) {
                throw new BotBrowserBridge.Failure("BROWSER_BACKEND_FAILED", "标签页渲染进程已异常退出");
            }
            BotBrowserPolicy.Sensitivity sensitivity = tab.effectiveSensitivity();
            if (sensitivity.blocksWebViewNavigation()) {
                throw new BotBrowserBridge.Failure("BROWSER_SENSITIVE_BLOCKED",
                        "Google 认证页必须在系统浏览器完成，已拒绝向 Bot WebView 注入输入");
            }
            if (sensitivity == BotBrowserPolicy.Sensitivity.SECRET_SHIELD) {
                throw new BotBrowserBridge.Failure("BROWSER_SENSITIVE_BLOCKED",
                        "当前页面命中凭据/Secret 隔离边界，已拒绝远程输入，请改用系统浏览器或私密控件");
            }

            backend.dispatchHumanInput(tab.handle, event, cancelled);
            session.revision.incrementAndGet();
            session.lastActiveAtMs = clock.nowMs();
            JSONObject out = buildStatusDto(availability, session, "human");
            out.put("ok", true);
            return out;
        } finally {
            session.lock.unlock();
        }
    }

    JSONObject release(String deviceId, String botId, BooleanSupplier cancelled)
            throws BotBrowserBridge.Failure, JSONException {
        ensureOpen();
        Availability availability = backend.probeAvailability(cancelled);
        String ownerKey = BotBrowserPolicy.ownerKey(deviceId, botId);
        BotSession removed;
        synchronized (stateLock) {
            removed = sessions.remove(ownerKey);
        }
        long finalRevision = 0L;
        if (removed != null) {
            removed.lock.lock();
            try {
                destroySessionTabsLocked(removed);
                removed.released = true;
                finalRevision = removed.revision.incrementAndGet();
            } finally {
                removed.lock.unlock();
            }
        }
        JSONObject out = buildStatusDto(availability, null, "human");
        out.put("revision", finalRevision);
        return out;
    }

    void shutdown() {
        if (!closed.compareAndSet(false, true)) return;
        List<BotSession> snapshot;
        synchronized (stateLock) {
            snapshot = new ArrayList<>(sessions.values());
            sessions.clear();
        }
        for (BotSession session : snapshot) {
            session.lock.lock();
            try {
                destroySessionTabsLocked(session);
                session.released = true;
            } finally {
                session.lock.unlock();
            }
        }
    }

    private void ensureOpen() throws BotBrowserBridge.Failure {
        if (closed.get()) {
            throw new BotBrowserBridge.Failure("BROWSER_UNAVAILABLE", "Android Bot 浏览器服务已关闭");
        }
    }

    private Availability requireAvailable(BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
        Availability availability = backend.probeAvailability(cancelled);
        if (!availability.available) {
            throw new BotBrowserBridge.Failure("BROWSER_PROFILE_UNSUPPORTED",
                    availability.reason != null ? availability.reason
                            : "当前设备不支持每 Bot 隔离 WebView Profile，请改用系统浏览器指导");
        }
        return availability;
    }

    private BotSession requireSession(String deviceId, String botId) throws BotBrowserBridge.Failure {
        String ownerKey = BotBrowserPolicy.ownerKey(deviceId, botId);
        BotSession session;
        synchronized (stateLock) {
            session = sessions.get(ownerKey);
        }
        if (session == null) {
            throw new BotBrowserBridge.Failure("BROWSER_PAGE_NOT_FOUND", "当前 Bot 尚未打开任何浏览器标签页");
        }
        return session;
    }

    private BotSession getOrCreateSession(String deviceId, String botId) throws BotBrowserBridge.Failure {
        String ownerKey = BotBrowserPolicy.ownerKey(deviceId, botId);
        String profileName = BotBrowserPolicy.profileNameForOwner(deviceId, botId);
        BotSession evicted = null;
        BotSession target;
        synchronized (stateLock) {
            target = sessions.get(ownerKey);
            if (target != null) return target;
            if (sessions.size() >= BotBrowserPolicy.MAX_BOT_SESSIONS) {
                // LRU 淘汰最久未活跃的空闲 Bot 会话，防止后台常驻 WebView 耗尽内存。
                String oldestKey = null;
                long oldestTime = Long.MAX_VALUE;
                for (Map.Entry<String, BotSession> entry : sessions.entrySet()) {
                    if (entry.getValue().lastActiveAtMs < oldestTime) {
                        oldestTime = entry.getValue().lastActiveAtMs;
                        oldestKey = entry.getKey();
                    }
                }
                if (oldestKey != null) {
                    evicted = sessions.remove(oldestKey);
                }
            }
            target = new BotSession(ownerKey, profileName, clock.nowMs());
            sessions.put(ownerKey, target);
        }
        if (evicted != null) {
            evicted.lock.lock();
            try {
                destroySessionTabsLocked(evicted);
                evicted.released = true;
            } finally {
                evicted.lock.unlock();
            }
        }
        return target;
    }

    private void reapIdleSessions() {
        long now = clock.nowMs();
        List<BotSession> expired = new ArrayList<>();
        synchronized (stateLock) {
            List<String> keys = new ArrayList<>(sessions.keySet());
            for (String key : keys) {
                BotSession session = sessions.get(key);
                if (session != null && now - session.lastActiveAtMs > IDLE_SESSION_TTL_MS) {
                    sessions.remove(key);
                    expired.add(session);
                }
            }
        }
        for (BotSession session : expired) {
            session.lock.lock();
            try {
                destroySessionTabsLocked(session);
                session.released = true;
            } finally {
                session.lock.unlock();
            }
        }
    }

    private void destroySessionTabsLocked(BotSession session) {
        for (TabState tab : session.tabs.values()) {
            try {
                backend.destroyTab(tab.handle);
            } catch (Throwable ignored) {
            }
        }
        session.tabs.clear();
        session.activePageId = null;
    }

    private TabState resolveTargetTab(BotSession session, JSONObject arguments)
            throws BotBrowserBridge.Failure {
        if (session.released || session.tabs.isEmpty()) {
            throw new BotBrowserBridge.Failure("BROWSER_PAGE_NOT_FOUND", "当前 Bot 没有存活的浏览器标签页");
        }
        String requested = arguments.optString("pageId", "").trim();
        String targetId = requested.isEmpty() ? session.activePageId : requested;
        TabState tab = targetId == null ? null : session.tabs.get(targetId);
        if (tab == null) {
            throw new BotBrowserBridge.Failure("BROWSER_PAGE_NOT_FOUND", "目标标签页不存在或不属于当前 Bot");
        }
        return tab;
    }

    private static void verifyOptionalRevision(BotSession session, JSONObject arguments)
            throws BotBrowserBridge.Failure {
        if (!arguments.has("revision") || arguments.isNull("revision")) return;
        Object raw = arguments.opt("revision");
        if (!(raw instanceof Number number)) {
            throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "revision 必须是整数");
        }
        long expected = number.longValue();
        if (expected != number.doubleValue() || expected < 0) {
            throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "revision 必须是非负整数");
        }
        long currentRevision = session.revision.get();
        if (expected != currentRevision) {
            throw new BotBrowserBridge.Failure("BROWSER_REVISION_MISMATCH",
                    "页面代际已变化（期望 revision=" + expected + "，当前=" + currentRevision + "），操作未执行");
        }
    }

    private static void validateHumanInputEvent(JSONObject event) throws BotBrowserBridge.Failure {
        if (event == null) {
            throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "input 需要 event 对象");
        }
        String kind = event.optString("kind", "");
        if (!BotBrowserPolicy.isAllowedInputKind(kind)) {
            throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "不支持的 input event.kind");
        }
        switch (kind) {
            case "click" -> {
                requireUnitCoord(event, "x");
                requireUnitCoord(event, "y");
            }
            case "text" -> {
                String text = event.optString("text", "");
                if (text.isEmpty() || text.length() > BotBrowserPolicy.MAX_TEXT_LENGTH
                        || text.indexOf('\0') >= 0) {
                    throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "input text 长度无效或含 NUL");
                }
            }
            case "key" -> {
                String key = event.optString("key", "");
                if (BotBrowserPolicy.resolveKeyCode(key) == null) {
                    throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "input key 不在允许按键集合内");
                }
            }
            case "wheel" -> {
                if (event.has("x") && !event.isNull("x")) requireUnitCoord(event, "x");
                if (event.has("y") && !event.isNull("y")) requireUnitCoord(event, "y");
                requireFiniteNumber(event, "deltaX", false);
                requireFiniteNumber(event, "deltaY", false);
            }
            default -> throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "不支持的 input event.kind");
        }
    }

    private static void requireUnitCoord(JSONObject event, String key) throws BotBrowserBridge.Failure {
        double value = requireFiniteNumber(event, key, true);
        if (value < 0.0 || value > 1.0) {
            throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", key + " 坐标必须在 0..1 范围内");
        }
    }

    private static double requireFiniteNumber(JSONObject obj, String key, boolean required)
            throws BotBrowserBridge.Failure {
        if (!obj.has(key) || obj.isNull(key)) {
            if (required) throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "缺少数值字段 " + key);
            return 0.0;
        }
        Object raw = obj.opt(key);
        if (!(raw instanceof Number number)) {
            throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", key + " 必须是数字");
        }
        double value = number.doubleValue();
        if (!Double.isFinite(value)) {
            throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", key + " 必须是有限数值");
        }
        return value;
    }

    private TabCallbacks createCallbacks(BotSession session, AtomicReference<TabState> tabRef) {
        return new TabCallbacks() {
            @Override
            public void onNavigationCommit(String url, BotBrowserPolicy.Sensitivity urlSensitivity,
                    String reason, boolean loading) {
                TabState tab = tabRef.get();
                if (tab == null) return;
                tab.url = url;
                tab.urlSensitivity = urlSensitivity;
                tab.urlSensitivityReason = reason;
                tab.domSensitivity = new BotBrowserPolicy.DomSensitivity(
                        BotBrowserPolicy.Sensitivity.NORMAL, null, false);
                tab.snapshotToken = null;
                tab.snapshotElements.clear();
                tab.loading = loading;
                tab.docGeneration++;
                session.revision.incrementAndGet();
            }

            @Override
            public void onPageFinished(String url) {
                TabState tab = tabRef.get();
                if (tab == null) return;
                tab.loading = false;
                if (url != null && !url.isEmpty()) tab.url = url;
                session.revision.incrementAndGet();
            }

            @Override
            public void onTitleChanged(String title) {
                TabState tab = tabRef.get();
                if (tab == null) return;
                tab.title = title == null ? "" : (title.length() > 256 ? title.substring(0, 256) : title);
            }

            @Override
            public void onBlockedExternalNavigation(String blockedReason) {
                TabState tab = tabRef.get();
                if (tab == null) return;
                tab.lastBlockedExternalReason = blockedReason;
                tab.loading = false;
                session.revision.incrementAndGet();
            }

            @Override
            public void onDownloadBlocked() {
                TabState tab = tabRef.get();
                if (tab == null) return;
                tab.downloadBlocked = true;
            }

            @Override
            public void onRenderProcessCrashed() {
                TabState tab = tabRef.get();
                if (tab == null) return;
                tab.crashed = true;
                tab.loading = false;
                session.revision.incrementAndGet();
            }
        };
    }

    private JSONObject buildStatusDto(Availability availability, BotSession session, String source)
            throws JSONException {
        JSONObject out = new JSONObject();
        out.put("available", availability.available);
        out.put("canStreamInteract", availability.available && availability.canStreamInteract);
        out.put("platform", "android");
        out.put("profileIsolation", availability.profileIsolation);
        out.put("externalBrowserRecommendedForSetup", true);
        if (!availability.available) {
            out.put("fallbackMode", "guide-browser");
        }
        if (availability.reason != null && !availability.reason.isEmpty()) {
            out.put("reason", availability.reason);
        }

        JSONArray tabs = new JSONArray();
        boolean activeSensitive = false;
        String activeSensitiveReason = null;
        boolean requiresSystemBrowser = !availability.available;
        boolean requiresHumanTakeover = false;

        if (session != null) {
            out.put("sessionId", session.sessionId);
            out.put("pageId", session.activePageId != null ? session.activePageId : JSONObject.NULL);
            out.put("revision", session.revision.get());
            for (TabState tab : session.tabs.values()) {
                BotBrowserPolicy.Sensitivity eff = tab.effectiveSensitivity();
                JSONObject item = new JSONObject();
                item.put("id", tab.id);
                item.put("title", eff.blocksAgentObservation() ? "" : tab.title);
                item.put("url", BotBrowserPolicy.sanitizeUrlForSource(tab.url, eff, source));
                item.put("loading", tab.loading);
                item.put("sensitive", eff.isSensitive());
                if (tab.crashed) item.put("crashed", true);
                tabs.put(item);
                if (tab.id.equals(session.activePageId)) {
                    activeSensitive = eff.isSensitive() || tab.lastBlockedExternalReason != null;
                    activeSensitiveReason = tab.lastBlockedExternalReason != null
                            ? tab.lastBlockedExternalReason
                            : tab.effectiveSensitivityReason();
                    requiresSystemBrowser = eff.requiresSystemBrowser()
                            || tab.lastBlockedExternalReason != null;
                    requiresHumanTakeover = tab.hasPolicyConsent();
                }
            }
        } else {
            out.put("sessionId", JSONObject.NULL);
            out.put("pageId", JSONObject.NULL);
            out.put("revision", 0L);
        }
        out.put("tabs", tabs);
        out.put("sensitive", activeSensitive);
        if (activeSensitiveReason != null) {
            out.put("sensitiveReason", activeSensitiveReason);
        }
        out.put("requiresSystemBrowser", requiresSystemBrowser);
        out.put("requiresHumanTakeover", requiresHumanTakeover);
        return out;
    }

    private static String lastTabId(BotSession session) {
        String last = null;
        for (String id : session.tabs.keySet()) last = id;
        return last;
    }

    private static String concatLabels(JSONObject item) {
        StringBuilder sb = new StringBuilder();
        appendPiece(sb, item.optString("text", ""));
        appendPiece(sb, item.optString("name", ""));
        appendPiece(sb, item.optString("placeholder", ""));
        appendPiece(sb, item.optString("ariaLabel", ""));
        return sb.toString();
    }

    private static void appendPiece(StringBuilder sb, String piece) {
        if (piece == null || piece.trim().isEmpty()) return;
        if (sb.length() > 0) sb.append(' ');
        sb.append(piece.trim());
    }

    private static int clampInt(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static void cancellableSleep(int ms, BooleanSupplier cancelled)
            throws BotBrowserBridge.Failure {
        long deadline = SystemClock.uptimeMillis() + ms;
        while (SystemClock.uptimeMillis() < deadline) {
            if (cancelled != null && cancelled.getAsBoolean()) {
                throw new BotBrowserBridge.Failure("CANCELLED", "浏览器等待已取消");
            }
            long remain = deadline - SystemClock.uptimeMillis();
            if (remain <= 0) break;
            try {
                Thread.sleep(Math.min(50L, remain));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new BotBrowserBridge.Failure("CANCELLED", "浏览器等待已中断");
            }
        }
    }

    // ==================== Real Android WebView Multi-Profile Backend ====================

    private static final class WebViewTabHandle implements TabHandle {
        final WebView webView;
        final int width;
        final int height;
        volatile boolean canBack;
        volatile boolean canForward;
        volatile boolean destroyed;

        WebViewTabHandle(WebView webView, int width, int height) {
            this.webView = webView;
            this.width = width;
            this.height = height;
        }

        @Override public int viewportWidth() { return width; }
        @Override public int viewportHeight() { return height; }
        @Override public boolean canGoBack() { return canBack; }
        @Override public boolean canGoForward() { return canForward; }
    }

    private static final class AndroidWebViewBackend implements Backend {
        private final Context appContext;
        private final Handler main = new Handler(Looper.getMainLooper());

        AndroidWebViewBackend(Context appContext) {
            this.appContext = appContext;
        }

        /**
         * 必须在默认进程首次触及 WebView / WebViewFeature 之前设置独立目录后缀，
         * 确保与 :tauri_ui（"tauri-ui"）及普通 App WebView 物理隔离。
         */
        private static void ensureProcessDataDirectorySuffix() {
            if (!DATA_DIR_SUFFIX_ATTEMPTED.compareAndSet(false, true)) return;
            try {
                WebView.setDataDirectorySuffix(PROCESS_DATA_DIR_SUFFIX);
            } catch (IllegalStateException ignored) {
                // 若默认进程已有其他组件提前初始化 WebView，仍由每 Bot 非默认 Profile 强制隔离；
                // 若设备不支持 MULTI_PROFILE，下方 probeAvailability 会诚实返回 unavailable。
            }
        }

        @Override
        public Availability probeAvailability(BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
            return runOnMain(() -> {
                ensureProcessDataDirectorySuffix();
                PackageInfo pkg;
                try {
                    pkg = WebView.getCurrentWebViewPackage();
                } catch (Throwable error) {
                    return Availability.unsupported(
                            "Android 系统 WebView 不可用，请改用外部系统浏览器指导");
                }
                if (pkg == null) {
                    return Availability.unsupported(
                            "当前设备未安装或已停用系统 WebView，请改用外部系统浏览器指导");
                }
                boolean multiProfile;
                try {
                    multiProfile = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE);
                } catch (Throwable error) {
                    multiProfile = false;
                }
                if (!multiProfile) {
                    return Availability.unsupported(
                            "当前系统 WebView 不支持每 Bot 独立 Profile（WebViewFeature.MULTI_PROFILE），"
                                    + "为避免共享默认 Cookies 已禁用内置浏览器，请改用外部系统浏览器指导");
                }
                return Availability.supported();
            }, cancelled);
        }

        @Override
        public TabHandle createTab(String profileName, int width, int height, TabCallbacks callbacks,
                BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
            if (Profile.DEFAULT_PROFILE_NAME.equalsIgnoreCase(profileName)) {
                throw new BotBrowserBridge.Failure("BROWSER_PROFILE_UNSUPPORTED",
                        "禁止使用默认 WebView Profile");
            }
            return runOnMain(() -> {
                ensureProcessDataDirectorySuffix();
                if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                    // 预先确保独立 Profile 存在，并在构造后第一时间绑定非默认 Profile。
                    ProfileStore.getInstance().getOrCreateProfile(profileName);
                    WebView webView = new WebView(appContext);
                    WebViewCompat.setProfile(webView, profileName);
                    Profile profile = WebViewCompat.getProfile(webView);
                    CookieManager profileCookies = profile.getCookieManager();
                    profileCookies.setAcceptCookie(true);
                    profileCookies.setAcceptThirdPartyCookies(webView, false);
                    return configureWebView(webView, width, height, callbacks);
                } else {
                    throw new BotBrowserBridge.Failure("BROWSER_PROFILE_UNSUPPORTED",
                            "当前系统 WebView 不支持每 Bot 独立 Profile");
                }
            }, cancelled);
        }

        @android.annotation.SuppressLint("SetJavaScriptEnabled")
        private WebViewTabHandle configureWebView(WebView webView, int width, int height,
                TabCallbacks callbacks) {

                WebSettings settings = webView.getSettings();
                settings.setJavaScriptEnabled(true);
                settings.setDomStorageEnabled(true);
                settings.setAllowFileAccess(false);
                settings.setAllowContentAccess(false);
                settings.setJavaScriptCanOpenWindowsAutomatically(false);
                settings.setSupportMultipleWindows(false);
                settings.setGeolocationEnabled(false);
                settings.setDatabaseEnabled(false);
                settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
                settings.setSafeBrowsingEnabled(true);
                settings.setMediaPlaybackRequiresUserGesture(true);
                settings.setUseWideViewPort(true);
                settings.setLoadWithOverviewMode(true);
                settings.setSupportZoom(false);
                settings.setBuiltInZoomControls(false);
                settings.setDisplayZoomControls(false);

                WebViewTabHandle handle = new WebViewTabHandle(webView, width, height);

                webView.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        Uri uri = request != null ? request.getUrl() : null;
                        String target = uri != null ? uri.toString() : "";
                        try {
                            BotBrowserPolicy.UrlCheck check = BotBrowserPolicy.validateNavigationUrl(target);
                            if (check.sensitivity.blocksWebViewNavigation()) {
                                callbacks.onBlockedExternalNavigation(check.reason);
                                return true; // 拦截跳转，绝不在 Bot WebView 加载 Google OAuth/登录页。
                            }
                            return false;
                        } catch (BotBrowserBridge.Failure blocked) {
                            callbacks.onBlockedExternalNavigation("blocked_url_scheme");
                            return true;
                        }
                    }

                    @Override
                    public void onPageStarted(WebView view, String url, Bitmap favicon) {
                        updateNavFlags(handle, view);
                        classifyAndNotify(url, true);
                    }

                    @Override
                    public void onPageCommitVisible(WebView view, String url) {
                        updateNavFlags(handle, view);
                        classifyAndNotify(url, false);
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        updateNavFlags(handle, view);
                        callbacks.onPageFinished(url);
                    }

                    @Override
                    public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                        updateNavFlags(handle, view);
                        classifyAndNotify(url, false);
                    }

                    @Override
                    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                        // 严禁忽略 TLS 证书错误。
                        handler.cancel();
                    }

                    @Override
                    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                        handle.destroyed = true;
                        callbacks.onRenderProcessCrashed();
                        try {
                            view.destroy();
                        } catch (Throwable ignored) {
                        }
                        return true; // 吞掉渲染进程崩溃，避免拖垮 Host 默认进程。
                    }

                    private void classifyAndNotify(String url, boolean loading) {
                        if (url == null || url.isEmpty()) return;
                        try {
                            BotBrowserPolicy.UrlCheck check = BotBrowserPolicy.validateNavigationUrl(url);
                            if (check.sensitivity.blocksWebViewNavigation()) {
                                webView.stopLoading();
                                webView.loadUrl("about:blank");
                                callbacks.onBlockedExternalNavigation(check.reason);
                                return;
                            }
                            callbacks.onNavigationCommit(check.canonicalUrl, check.sensitivity, check.reason, loading);
                        } catch (BotBrowserBridge.Failure blocked) {
                            webView.stopLoading();
                            webView.loadUrl("about:blank");
                            callbacks.onBlockedExternalNavigation("blocked_url_scheme");
                        }
                    }
                });

                webView.setWebChromeClient(new WebChromeClient() {
                    @Override
                    public void onReceivedTitle(WebView view, String title) {
                        callbacks.onTitleChanged(title);
                    }

                    @Override
                    public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                        result.cancel();
                        return true;
                    }

                    @Override
                    public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                        result.cancel();
                        return true;
                    }

                    @Override
                    public boolean onJsPrompt(WebView view, String url, String message, String defaultValue,
                            JsPromptResult result) {
                        result.cancel();
                        return true;
                    }

                    @Override
                    public boolean onJsBeforeUnload(WebView view, String url, String message, JsResult result) {
                        result.cancel();
                        return true;
                    }

                    @Override
                    public void onPermissionRequest(PermissionRequest request) {
                        request.deny();
                    }

                    @Override
                    public void onGeolocationPermissionsShowPrompt(String origin,
                            GeolocationPermissions.Callback callback) {
                        callback.invoke(origin, false, false);
                    }

                    @Override
                    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback,
                            FileChooserParams fileChooserParams) {
                        return false;
                    }
                });

                // 阻断静默下载（尤其防止 client_secret_*.json 被 Bot 自动落盘读取）。
                webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) ->
                        callbacks.onDownloadBlocked());

                // 离屏软件渲染以支持在无 Activity 窗口的后台服务中绘制真实画面帧。
                webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
                layoutWebView(webView, width, height);
                webView.onResume();
                return handle;
        }

        @Override
        public void loadUrl(TabHandle tab, String url, BooleanSupplier cancelled)
                throws BotBrowserBridge.Failure {
            WebViewTabHandle wv = asWebView(tab);
            runOnMain(() -> {
                ensureAlive(wv);
                wv.webView.loadUrl(url);
                updateNavFlags(wv, wv.webView);
                return null;
            }, cancelled);
        }

        @Override
        public boolean goBack(TabHandle tab, BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
            WebViewTabHandle wv = asWebView(tab);
            return runOnMain(() -> {
                ensureAlive(wv);
                boolean can = wv.webView.canGoBack();
                if (can) wv.webView.goBack();
                updateNavFlags(wv, wv.webView);
                return can;
            }, cancelled);
        }

        @Override
        public boolean goForward(TabHandle tab, BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
            WebViewTabHandle wv = asWebView(tab);
            return runOnMain(() -> {
                ensureAlive(wv);
                boolean can = wv.webView.canGoForward();
                if (can) wv.webView.goForward();
                updateNavFlags(wv, wv.webView);
                return can;
            }, cancelled);
        }

        @Override
        public void reload(TabHandle tab, BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
            WebViewTabHandle wv = asWebView(tab);
            runOnMain(() -> {
                ensureAlive(wv);
                wv.webView.reload();
                return null;
            }, cancelled);
        }

        @Override
        public FrameCapture captureFrame(TabHandle tab, int maxWidth, int maxHeight, int maxBytes,
                String preferredMimeType, BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
            WebViewTabHandle wv = asWebView(tab);
            Bitmap captured = runOnMain(() -> {
                ensureAlive(wv);
                if (wv.webView.getWidth() != wv.width || wv.webView.getHeight() != wv.height) {
                    layoutWebView(wv.webView, wv.width, wv.height);
                }
                Bitmap bitmap = Bitmap.createBitmap(wv.width, wv.height, Bitmap.Config.ARGB_8888);
                Canvas canvas = new Canvas(bitmap);
                canvas.drawColor(Color.WHITE);
                wv.webView.draw(canvas);
                return bitmap;
            }, cancelled);

            Bitmap scaled = captured;
            try {
                int targetW = wv.width;
                int targetH = wv.height;
                if (targetW > maxWidth || targetH > maxHeight) {
                    double scale = Math.min((double) maxWidth / targetW, (double) maxHeight / targetH);
                    targetW = Math.max(1, (int) Math.round(targetW * scale));
                    targetH = Math.max(1, (int) Math.round(targetH * scale));
                    scaled = Bitmap.createScaledBitmap(captured, targetW, targetH, true);
                }

                if ("image/png".equals(preferredMimeType)) {
                    ByteArrayOutputStream pngOut = new ByteArrayOutputStream();
                    if (scaled.compress(Bitmap.CompressFormat.PNG, 100, pngOut)) {
                        String b64 = Base64.encodeToString(pngOut.toByteArray(), Base64.NO_WRAP);
                        if (b64.length() <= maxBytes) {
                            return new FrameCapture("image/png", b64, wv.width, wv.height,
                                    scaled.getWidth(), scaled.getHeight());
                        }
                    }
                }

                for (int quality : JPEG_QUALITIES) {
                    ByteArrayOutputStream jpegOut = new ByteArrayOutputStream();
                    if (!scaled.compress(Bitmap.CompressFormat.JPEG, quality, jpegOut)) continue;
                    String b64 = Base64.encodeToString(jpegOut.toByteArray(), Base64.NO_WRAP);
                    if (b64.length() <= maxBytes) {
                        return new FrameCapture("image/jpeg", b64, wv.width, wv.height,
                                scaled.getWidth(), scaled.getHeight());
                    }
                }
                throw new BotBrowserBridge.Failure("BROWSER_FRAME_TOO_LARGE",
                        "画面压缩后仍超过最大字节预算");
            } finally {
                if (scaled != captured && scaled != null && !scaled.isRecycled()) {
                    scaled.recycle();
                }
                if (captured != null && !captured.isRecycled()) {
                    captured.recycle();
                }
            }
        }

        @Override
        public JSONObject snapshotDom(TabHandle tab, String snapshotToken, String source,
                BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
            WebViewTabHandle wv = asWebView(tab);
            String script = buildSnapshotScript(snapshotToken, source);
            return evaluateJson(wv, script, cancelled);
        }

        @Override
        public JSONObject actDom(TabHandle tab, String snapshotToken, String source, String currentUrl,
                JSONObject act, BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
            WebViewTabHandle wv = asWebView(tab);
            String script = buildActScript(snapshotToken, source, currentUrl, act);
            return evaluateJson(wv, script, cancelled);
        }

        @Override
        public void dispatchHumanInput(TabHandle tab, JSONObject event, BooleanSupplier cancelled)
                throws BotBrowserBridge.Failure {
            WebViewTabHandle wv = asWebView(tab);
            String kind = event.optString("kind", "");
            if ("text".equals(kind)) {
                String text = event.optString("text", "");
                boolean committed = runOnMain(() -> {
                    ensureAlive(wv);
                    EditorInfo info = new EditorInfo();
                    InputConnection ic = wv.webView.onCreateInputConnection(info);
                    if (ic != null) {
                        return ic.commitText(text, 1);
                    }
                    return false;
                }, cancelled);
                if (!committed) {
                    // 离屏 WebView 未挂载窗口时 onCreateInputConnection 可能返回 null，回退到受控固定焦点插入。
                    evaluateJson(wv, buildHumanTextFallbackScript(text), cancelled);
                }
                return;
            }

            runOnMain(() -> {
                ensureAlive(wv);
                switch (kind) {
                    case "click" -> {
                        float px = (float) (event.optDouble("x", 0.5) * wv.width);
                        float py = (float) (event.optDouble("y", 0.5) * wv.height);
                        long downTime = SystemClock.uptimeMillis();
                        MotionEvent down = MotionEvent.obtain(downTime, downTime,
                                MotionEvent.ACTION_DOWN, px, py, 0);
                        MotionEvent up = MotionEvent.obtain(downTime, downTime + 25L,
                                MotionEvent.ACTION_UP, px, py, 0);
                        try {
                            wv.webView.dispatchTouchEvent(down);
                            wv.webView.dispatchTouchEvent(up);
                        } finally {
                            down.recycle();
                            up.recycle();
                        }
                    }
                    case "key" -> {
                        Integer keyCode = BotBrowserPolicy.resolveKeyCode(event.optString("key", ""));
                        if (keyCode == null) {
                            throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "不支持的按键名");
                        }
                        long now = SystemClock.uptimeMillis();
                        KeyEvent down = new KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0);
                        KeyEvent up = new KeyEvent(now, now + 15L, KeyEvent.ACTION_UP, keyCode, 0);
                        wv.webView.dispatchKeyEvent(down);
                        wv.webView.dispatchKeyEvent(up);
                    }
                    case "wheel" -> {
                        float px = (float) (event.optDouble("x", 0.5) * wv.width);
                        float py = (float) (event.optDouble("y", 0.5) * wv.height);
                        int dx = clampInt((int) Math.round(event.optDouble("deltaX", 0.0)),
                                -BotBrowserPolicy.MAX_WHEEL_DELTA, BotBrowserPolicy.MAX_WHEEL_DELTA);
                        int dy = clampInt((int) Math.round(event.optDouble("deltaY", 0.0)),
                                -BotBrowserPolicy.MAX_WHEEL_DELTA, BotBrowserPolicy.MAX_WHEEL_DELTA);
                        int beforeX = wv.webView.getScrollX();
                        int beforeY = wv.webView.getScrollY();

                        MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[1];
                        props[0] = new MotionEvent.PointerProperties();
                        props[0].id = 0;
                        props[0].toolType = MotionEvent.TOOL_TYPE_MOUSE;
                        MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[1];
                        coords[0] = new MotionEvent.PointerCoords();
                        coords[0].x = px;
                        coords[0].y = py;
                        coords[0].setAxisValue(MotionEvent.AXIS_HSCROLL, -dx / 80f);
                        coords[0].setAxisValue(MotionEvent.AXIS_VSCROLL, -dy / 80f);
                        long now = SystemClock.uptimeMillis();
                        MotionEvent scroll = MotionEvent.obtain(
                                now, now, MotionEvent.ACTION_SCROLL, 1, props, coords,
                                0, 0, 1.0f, 1.0f, 0, 0, InputDevice.SOURCE_CLASS_POINTER, 0);
                        try {
                            wv.webView.dispatchGenericMotionEvent(scroll);
                        } finally {
                            scroll.recycle();
                        }
                        if (wv.webView.getScrollX() == beforeX && wv.webView.getScrollY() == beforeY) {
                            wv.webView.scrollBy(dx, dy);
                        }
                    }
                    default -> throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "未知 input kind");
                }
                return null;
            }, cancelled);
        }

        @Override
        public void destroyTab(TabHandle tab) {
            if (!(tab instanceof WebViewTabHandle wv)) return;
            wv.destroyed = true;
            Runnable destroyTask = () -> {
                try {
                    wv.webView.stopLoading();
                    wv.webView.onPause();
                    wv.webView.loadUrl("about:blank");
                    wv.webView.destroy();
                } catch (Throwable ignored) {
                }
            };
            if (Looper.myLooper() == Looper.getMainLooper()) {
                destroyTask.run();
            } else {
                main.post(destroyTask);
            }
        }

        private JSONObject evaluateJson(WebViewTabHandle wv, String script, BooleanSupplier cancelled)
                throws BotBrowserBridge.Failure {
            CompletableFuture<String> eval = new CompletableFuture<>();
            runOnMain(() -> {
                ensureAlive(wv);
                wv.webView.evaluateJavascript(script, eval::complete);
                return null;
            }, cancelled);

            long deadline = SystemClock.uptimeMillis() + EVAL_JS_TIMEOUT_MS;
            while (true) {
                if (cancelled != null && cancelled.getAsBoolean()) {
                    throw new BotBrowserBridge.Failure("CANCELLED", "页面操作已取消");
                }
                long remain = deadline - SystemClock.uptimeMillis();
                if (remain <= 0) {
                    throw new BotBrowserBridge.Failure("BROWSER_BUSY", "页面响应超时");
                }
                try {
                    String raw = eval.get(Math.min(50L, remain), TimeUnit.MILLISECONDS);
                    return decodeEvalJson(raw);
                } catch (java.util.concurrent.TimeoutException ignored) {
                    // 继续轮询直至超时或取消。
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new BotBrowserBridge.Failure("CANCELLED", "页面操作已中断");
                } catch (Exception other) {
                    throw new BotBrowserBridge.Failure("BROWSER_BACKEND_FAILED", "页面脚本执行失败");
                }
            }
        }

        private static JSONObject decodeEvalJson(String raw) throws BotBrowserBridge.Failure {
            if (raw == null || raw.isEmpty() || "null".equals(raw)) {
                throw new BotBrowserBridge.Failure("BROWSER_BACKEND_FAILED", "页面返回空结果");
            }
            try {
                Object parsed = new JSONTokener(raw).nextValue();
                if (parsed instanceof JSONObject obj) return obj;
                if (parsed instanceof String str) return new JSONObject(str);
                throw new BotBrowserBridge.Failure("BROWSER_BACKEND_FAILED", "页面返回非对象结果");
            } catch (JSONException invalid) {
                throw new BotBrowserBridge.Failure("BROWSER_BACKEND_FAILED", "页面返回 JSON 无法解析");
            }
        }

        private <T> T runOnMain(Callable<T> task, BooleanSupplier cancelled)
                throws BotBrowserBridge.Failure {
            if (cancelled != null && cancelled.getAsBoolean()) {
                throw new BotBrowserBridge.Failure("CANCELLED", "浏览器操作已取消");
            }
            if (Looper.myLooper() == Looper.getMainLooper()) {
                try {
                    return task.call();
                } catch (BotBrowserBridge.Failure f) {
                    throw f;
                } catch (Exception e) {
                    throw new BotBrowserBridge.Failure("BROWSER_BACKEND_FAILED", "主线程浏览器调用失败");
                }
            }
            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<T> result = new AtomicReference<>();
            AtomicReference<Throwable> error = new AtomicReference<>();
            if (!main.post(() -> {
                try {
                    result.set(task.call());
                } catch (Throwable t) {
                    error.set(t);
                } finally {
                    latch.countDown();
                }
            })) {
                throw new BotBrowserBridge.Failure("BROWSER_UNAVAILABLE", "Android 主线程队列不可用");
            }
            long deadline = SystemClock.uptimeMillis() + MAIN_THREAD_TIMEOUT_MS;
            while (true) {
                if (cancelled != null && cancelled.getAsBoolean()) {
                    throw new BotBrowserBridge.Failure("CANCELLED", "浏览器操作已取消");
                }
                long remain = deadline - SystemClock.uptimeMillis();
                if (remain <= 0) {
                    throw new BotBrowserBridge.Failure("BROWSER_BUSY", "主线程浏览器调用超时");
                }
                try {
                    if (latch.await(Math.min(50L, remain), TimeUnit.MILLISECONDS)) break;
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new BotBrowserBridge.Failure("CANCELLED", "浏览器操作已中断");
                }
            }
            Throwable thrown = error.get();
            if (thrown != null) {
                if (thrown instanceof BotBrowserBridge.Failure f) throw f;
                throw new BotBrowserBridge.Failure("BROWSER_BACKEND_FAILED", "主线程浏览器执行失败");
            }
            return result.get();
        }

        private static WebViewTabHandle asWebView(TabHandle tab) throws BotBrowserBridge.Failure {
            if (!(tab instanceof WebViewTabHandle wv)) {
                throw new BotBrowserBridge.Failure("BROWSER_BACKEND_FAILED", "无效标签页句柄");
            }
            return wv;
        }

        private static void ensureAlive(WebViewTabHandle wv) throws BotBrowserBridge.Failure {
            if (wv.destroyed) {
                throw new BotBrowserBridge.Failure("BROWSER_PAGE_NOT_FOUND", "标签页已销毁");
            }
        }

        private static void layoutWebView(WebView webView, int width, int height) {
            int wSpec = View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY);
            int hSpec = View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY);
            webView.measure(wSpec, hSpec);
            webView.layout(0, 0, width, height);
        }

        private static void updateNavFlags(WebViewTabHandle handle, WebView view) {
            try {
                handle.canBack = view.canGoBack();
                handle.canForward = view.canGoForward();
            } catch (Throwable ignored) {
            }
        }
    }

    // ==================== Fixed Parameterized DOM Scripts (Zero Arbitrary Eval) ====================

    private static String buildSnapshotScript(String snapshotToken, String source) {
        return "(() => {"
                + "const token = " + BotBrowserPolicy.jsStringLiteral(snapshotToken) + ";"
                + "const source = " + BotBrowserPolicy.jsStringLiteral(source) + ";"
                + "const isVis = (el) => {"
                + "  if (!el || !el.getBoundingClientRect) return false;"
                + "  const s = window.getComputedStyle(el);"
                + "  if (!s || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;"
                + "  const r = el.getBoundingClientRect();"
                + "  return r.width > 0 && r.height > 0;"
                + "};"
                + "const bodyText = (document.body && document.body.innerText) ? String(document.body.innerText) : '';"
                + "const lowerBody = bodyText.toLowerCase();"
                + "const inputs = Array.from(document.querySelectorAll('input,textarea'));"
                + "let hasPasswordField = false, hasOtpField = false, hasCardField = false;"
                + "for (const el of inputs) {"
                + "  if (!isVis(el)) continue;"
                + "  const t = String(el.type || '').toLowerCase();"
                + "  const ac = String(el.getAttribute('autocomplete') || '').toLowerCase();"
                + "  if (t === 'password' || ac.includes('password')) hasPasswordField = true;"
                + "  if (ac.includes('one-time-code')) hasOtpField = true;"
                + "  if (ac.startsWith('cc-')) hasCardField = true;"
                + "}"
                + "const hasSecretDialog = (lowerBody.includes('your client secret')"
                + "  || (lowerBody.includes('client secret') && (lowerBody.includes('download json') || lowerBody.includes('oauth client created')))"
                + "  || /GOCSPX-[A-Za-z0-9_-]{8,}/.test(bodyText));"
                + "const hasPolicyConsent = (lowerBody.includes('user data policy')"
                + "  || (lowerBody.includes('google api services') && lowerBody.includes('i agree')));"
                + "if (source === 'agent' && (hasPasswordField || hasOtpField || hasCardField || hasSecretDialog)) {"
                + "  return { sensitiveBlocked: true, hasPasswordField, hasOtpField, hasCardField, hasSecretDialog, hasPolicyConsent };"
                + "}"
                + "const sym = Symbol.for('pibot.android.refmap.v1');"
                + "const refMap = new Map();"
                + "window[sym] = { token, map: refMap };"
                + "const vw = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);"
                + "const vh = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);"
                + "const selector = 'a[href],button,input,textarea,select,[role=\"button\"],[role=\"link\"],[role=\"checkbox\"],[role=\"radio\"],[role=\"tab\"],[role=\"menuitem\"],[role=\"textbox\"],[contenteditable=\"true\"]';"
                + "const nodes = Array.from(document.querySelectorAll(selector));"
                + "const interactive = [];"
                + "let idx = 0;"
                + "for (const el of nodes) {"
                + "  if (interactive.length >= 80) break;"
                + "  if (!isVis(el)) continue;"
                + "  const ref = 'e' + (++idx);"
                + "  refMap.set(ref, el);"
                + "  const tag = String(el.tagName || '').toLowerCase();"
                + "  const type = String(el.type || '').toLowerCase();"
                + "  const ac = String(el.getAttribute('autocomplete') || '').toLowerCase();"
                + "  const isSensitiveInput = (type === 'password' || ac.includes('password') || ac.includes('one-time-code') || ac.startsWith('cc-'));"
                + "  const r = el.getBoundingClientRect();"
                + "  let lbl = String(el.getAttribute('aria-label') || '');"
                + "  if (!lbl && el.id) {"
                + "    const lNode = document.querySelector('label[for=\"' + CSS.escape(el.id) + '\"]');"
                + "    if (lNode) lbl = String(lNode.innerText || '');"
                + "  }"
                + "  if (!lbl && el.closest && el.closest('label')) lbl = String(el.closest('label').innerText || '');"
                + "  const rawVal = (!isSensitiveInput && 'value' in el && typeof el.value === 'string') ? el.value : '';"
                + "  const safeVal = /GOCSPX-[A-Za-z0-9_-]{8,}/.test(rawVal) ? '[REDACTED]' : rawVal.slice(0, 200);"
                + "  const txt = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160);"
                + "  interactive.push({"
                + "    ref, tag,"
                + "    role: String(el.getAttribute('role') || ''),"
                + "    type, autocomplete: ac,"
                + "    name: String(el.getAttribute('name') || '').slice(0, 80),"
                + "    ariaLabel: lbl.replace(/\\s+/g, ' ').trim().slice(0, 160),"
                + "    text: txt,"
                + "    value: safeVal,"
                + "    placeholder: String(el.getAttribute('placeholder') || '').slice(0, 100),"
                + "    checked: !!el.checked,"
                + "    disabled: !!el.disabled,"
                + "    href: (tag === 'a' && el.href) ? String(el.href).slice(0, 300) : '',"
                + "    rect: { x: Math.max(0, Math.min(1, r.left / vw)), y: Math.max(0, Math.min(1, r.top / vh)), width: Math.max(0, Math.min(1, r.width / vw)), height: Math.max(0, Math.min(1, r.height / vh)) }"
                + "  });"
                + "}"
                + "const cleaned = bodyText.replace(/GOCSPX-[A-Za-z0-9_-]{8,}/g, '[REDACTED]').replace(/\\s+/g, ' ').trim();"
                + "const truncated = cleaned.length > 4096 || nodes.length > 80;"
                + "return { sensitiveBlocked: false, hasPasswordField, hasOtpField, hasCardField, hasSecretDialog, hasPolicyConsent, interactive, textSummary: cleaned.slice(0, 4096), truncated };"
                + "})()";
    }

    private static String buildActScript(String snapshotToken, String source, String currentUrl,
            JSONObject act) {
        String kind = act.optString("kind", "");
        String ref = act.optString("ref", "");
        String text = act.optString("text", "");
        String value = act.optString("value", text);
        String key = act.optString("key", "");
        int dx = clampInt((int) Math.round(act.optDouble("deltaX", 0.0)),
                -BotBrowserPolicy.MAX_WHEEL_DELTA, BotBrowserPolicy.MAX_WHEEL_DELTA);
        int dy = clampInt((int) Math.round(act.optDouble("deltaY", 0.0)),
                -BotBrowserPolicy.MAX_WHEEL_DELTA, BotBrowserPolicy.MAX_WHEEL_DELTA);

        return "(() => {"
                + "const token = " + BotBrowserPolicy.jsStringLiteral(snapshotToken) + ";"
                + "const source = " + BotBrowserPolicy.jsStringLiteral(source) + ";"
                + "const pageUrl = " + BotBrowserPolicy.jsStringLiteral(currentUrl == null ? "" : currentUrl) + ".toLowerCase();"
                + "const kind = " + BotBrowserPolicy.jsStringLiteral(kind) + ";"
                + "const ref = " + BotBrowserPolicy.jsStringLiteral(ref) + ";"
                + "const textVal = " + BotBrowserPolicy.jsStringLiteral(text) + ";"
                + "const selectVal = " + BotBrowserPolicy.jsStringLiteral(value) + ";"
                + "const keyName = " + BotBrowserPolicy.jsStringLiteral(key) + ";"
                + "const dx = " + dx + "; const dy = " + dy + ";"
                + "let el = null;"
                + "if (ref) {"
                + "  const store = window[Symbol.for('pibot.android.refmap.v1')];"
                + "  if (!store || store.token !== token) return { ok: false, code: 'BROWSER_REVISION_MISMATCH', message: '页面快照已过期，请重新 snapshot' };"
                + "  el = store.map.get(ref) || null;"
                + "  if (!el || !el.isConnected) return { ok: false, code: 'BROWSER_REVISION_MISMATCH', message: '目标元素已不存在，请重新 snapshot' };"
                + "}"
                + "const labelOf = (node) => {"
                + "  if (!node) return '';"
                + "  let s = [node.innerText, node.textContent, node.getAttribute && node.getAttribute('aria-label'), node.getAttribute && node.getAttribute('name'), node.getAttribute && node.getAttribute('placeholder')].filter(Boolean).join(' ');"
                + "  if (node.closest && node.closest('label')) s += ' ' + (node.closest('label').innerText || '');"
                + "  return String(s).replace(/\\s+/g, ' ').trim().toLowerCase();"
                + "};"
                + "if (source === 'agent' && el) {"
                + "  const t = String(el.type || '').toLowerCase();"
                + "  const ac = String(el.getAttribute && el.getAttribute('autocomplete') || '').toLowerCase();"
                + "  const lbl = labelOf(el);"
                + "  const onOAuth = pageUrl.includes('console.cloud.google.com') && (pageUrl.includes('/apis/credentials/oauthclient') || pageUrl.includes('/auth/clients'));"
                + "  const onConsent = pageUrl.includes('console.cloud.google.com') && (pageUrl.includes('/auth/overview/create') || pageUrl.includes('/apis/credentials/consent'));"
                + "  if (t === 'password' || ac.includes('password') || ac.includes('one-time-code') || ac.startsWith('cc-')"
                + "      || lbl.includes('user data policy') || lbl.includes('terms of service') || lbl.includes('i agree to')"
                + "      || lbl.includes('accept terms') || lbl.includes('client secret') || lbl.includes('download json')"
                + "      || lbl.includes('copy secret') || lbl.includes('show secret') || lbl.includes('reset secret')"
                + "      || (onOAuth && (lbl === 'create' || lbl.startsWith('create ') || lbl.includes('create oauth') || lbl.includes('create client')))"
                + "      || (onConsent && (lbl === 'finish' || lbl === 'create'))) {"
                + "    return { ok: false, code: 'BROWSER_SENSITIVE_BLOCKED', message: '命中条款/凭据敏感控件，Bot 已停手等待人类接管' };"
                + "  }"
                + "}"
                + "const setNativeVal = (node, val) => {"
                + "  const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;"
                + "  const desc = Object.getOwnPropertyDescriptor(proto, 'value');"
                + "  if (desc && desc.set) desc.set.call(node, val); else node.value = val;"
                + "  node.dispatchEvent(new Event('input', { bubbles: true }));"
                + "  node.dispatchEvent(new Event('change', { bubbles: true }));"
                + "};"
                + "if (kind === 'click') {"
                + "  el.scrollIntoView({ block: 'center', inline: 'center' });"
                + "  if (el.focus) el.focus();"
                + "  el.click();"
                + "  return { ok: true };"
                + "}"
                + "if (kind === 'fill' || kind === 'type') {"
                + "  el.scrollIntoView({ block: 'center', inline: 'center' });"
                + "  if (el.focus) el.focus();"
                + "  if (el.isContentEditable) {"
                + "    el.textContent = (kind === 'type' ? String(el.textContent || '') : '') + textVal;"
                + "    el.dispatchEvent(new Event('input', { bubbles: true }));"
                + "  } else {"
                + "    const next = (kind === 'type' ? String(el.value || '') : '') + textVal;"
                + "    setNativeVal(el, next);"
                + "  }"
                + "  return { ok: true };"
                + "}"
                + "if (kind === 'select') {"
                + "  el.scrollIntoView({ block: 'center', inline: 'center' });"
                + "  el.value = selectVal;"
                + "  el.dispatchEvent(new Event('input', { bubbles: true }));"
                + "  el.dispatchEvent(new Event('change', { bubbles: true }));"
                + "  return { ok: true };"
                + "}"
                + "if (kind === 'check' || kind === 'uncheck') {"
                + "  const want = (kind === 'check');"
                + "  el.scrollIntoView({ block: 'center', inline: 'center' });"
                + "  if (!!el.checked !== want) el.click();"
                + "  return { ok: true };"
                + "}"
                + "if (kind === 'press') {"
                + "  const target = el || document.activeElement || document.body;"
                + "  if (target && target.focus) target.focus();"
                + "  target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }));"
                + "  target.dispatchEvent(new KeyboardEvent('keyup', { key: keyName, bubbles: true, cancelable: true }));"
                + "  return { ok: true };"
                + "}"
                + "if (kind === 'scroll') {"
                + "  if (el) el.scrollIntoView({ block: 'center', inline: 'center' });"
                + "  else window.scrollBy(dx, dy);"
                + "  return { ok: true };"
                + "}"
                + "return { ok: false, code: 'INVALID_ARGUMENT', message: '不支持的操作类型' };"
                + "})()";
    }

    private static String buildHumanTextFallbackScript(String text) {
        return "(() => {"
                + "const insert = " + BotBrowserPolicy.jsStringLiteral(text) + ";"
                + "const el = document.activeElement;"
                + "if (!el) return { ok: true };"
                + "if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {"
                + "  const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;"
                + "  const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;"
                + "  const next = el.value.slice(0, start) + insert + el.value.slice(end);"
                + "  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;"
                + "  const desc = Object.getOwnPropertyDescriptor(proto, 'value');"
                + "  if (desc && desc.set) desc.set.call(el, next); else el.value = next;"
                + "  const caret = start + insert.length;"
                + "  if (el.setSelectionRange) try { el.setSelectionRange(caret, caret); } catch (_) {}"
                + "  el.dispatchEvent(new Event('input', { bubbles: true }));"
                + "} else if (el.isContentEditable) {"
                + "  el.textContent = String(el.textContent || '') + insert;"
                + "  el.dispatchEvent(new Event('input', { bubbles: true }));"
                + "}"
                + "return { ok: true };"
                + "})()";
    }
}
