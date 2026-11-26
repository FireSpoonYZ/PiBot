package com.example.launcherprobe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.os.Process;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.ClientCertRequest;
import android.webkit.HttpAuthHandler;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SafeBrowsingResponse;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.util.List;

/**
 * M18 Tauri 界面入口：独立 {@code :tauri_ui} 进程，SDK 退出只结束本进程，
 * 默认进程的 Host/FGS 不受影响。
 */
public class TauriMainActivity extends TauriActivity {
    static {
        // 必须在本进程首个 WebView 创建前设置独立数据目录，避免多进程 WebView 冲突。
        WebView.setDataDirectorySuffix("tauri-ui");
    }

    private final BroadcastReceiver clientEvents = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (BotClientService.ACTION_CLOSE_UI.equals(intent.getAction())) {
                finishAndRemoveTask();
            } else if (ClientUpdateNotifications.ACTION_STATUS_CHANGED.equals(intent.getAction()) && activeWebView != null) {
                activeWebView.evaluateJavascript("window.dispatchEvent(new Event('assistant-update-changed'))", null);
            }
        }
    };
    private volatile boolean resumed;
    private View insetsTarget;
    private WebView activeWebView;
    private final WebViewInsetsState insetsState = new WebViewInsetsState();
    private ScriptHandler documentStartScriptHandler;
    private boolean documentStartScriptChecked;
    private boolean documentStartScriptSupported;
    private String launchDeviceId;
    private String launchBotId;
    private static final String TAG = "TauriMainActivity";
    private static final String TARGET_DEVICE = "assistant_device_id";
    private static final String TARGET_BOT = "assistant_bot_id";
    private static final int LIGHT_BG_COLOR = 0xfffaf9f6;
    private static final int DARK_BG_COLOR = 0xff191b19;

    @Override protected void onCreate(Bundle savedInstanceState) {
        if (savedInstanceState != null) {
            launchDeviceId = savedInstanceState.getString(TARGET_DEVICE);
            launchBotId = savedInstanceState.getString(TARGET_BOT);
        }
        captureLaunchTarget(getIntent());
        super.onCreate(savedInstanceState);
        IntentFilter events = new IntentFilter(BotClientService.ACTION_CLOSE_UI);
        events.addAction(ClientUpdateNotifications.ACTION_STATUS_CHANGED);
        registerReceiver(clientEvents, events, Context.RECEIVER_NOT_EXPORTED);
        startClient();
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= 30
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        // 沿用既有外观偏好决定状态/导航栏图标明暗；状态栏与导航栏完全透明以实现全面屏沉浸。
        applyAppearance();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                handleBackNavigation();
            }
        });
    }

    /** 同步状态栏/导航栏明暗及窗口、WebView 底色，避免系统深浅色或外观偏好变更后残留旧色。 */
    private void applyAppearance() {
        AppAppearance appearance = AppAppearance.read(this);
        int bgColor = appearance.dark ? DARK_BG_COLOR : LIGHT_BG_COLOR;
        appearance.applySystemBars(this, Color.TRANSPARENT);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(!appearance.dark);
            controller.setAppearanceLightNavigationBars(!appearance.dark);
        }
        // edge-to-edge 下窗口底色与前端主背景一致，避免首帧（含首次安装 visibility:hidden）或边缘露白。
        getWindow().setBackgroundDrawable(new ColorDrawable(bgColor));
        getWindow().getDecorView().setBackgroundColor(bgColor);
        View content = getWindow().getDecorView().findViewById(android.R.id.content);
        if (content != null) {
            content.setBackgroundColor(bgColor);
        }
        if (activeWebView != null) {
            activeWebView.setBackgroundColor(bgColor);
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        startClient();
        if (captureLaunchTarget(intent) && activeWebView != null) {
            activeWebView.evaluateJavascript("window.dispatchEvent(new Event('assistant-open-chat'))", null);
        }
        if (intent != null && ClientUpdateNotifications.ACTION_OPEN.equals(intent.getAction()) && activeWebView != null) {
            activeWebView.evaluateJavascript("window.dispatchEvent(new Event('assistant-open-update'))", null);
        }
    }

    private void startClient() {
        try {
            BotHostService.startClientFromActivity(this);
        } catch (RuntimeException failure) {
            Log.e("TauriMainActivity", "Client foreground service start failed", failure);
            Toast.makeText(this, R.string.client_start_failed, Toast.LENGTH_LONG).show();
        }
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        if (launchDeviceId != null && launchBotId != null) {
            state.putString(TARGET_DEVICE, launchDeviceId);
            state.putString(TARGET_BOT, launchBotId);
        }
        super.onSaveInstanceState(state);
    }

    private boolean captureLaunchTarget(Intent intent) {
        if (intent == null) return false;
        String deviceId = intent.getStringExtra(TARGET_DEVICE);
        String botId = intent.getStringExtra(TARGET_BOT);
        intent.removeExtra(TARGET_DEVICE);
        intent.removeExtra(TARGET_BOT);
        if (deviceId == null || deviceId.isEmpty() || botId == null || botId.isEmpty()) return false;
        launchDeviceId = deviceId;
        launchBotId = botId;
        return true;
    }

    /** 在主线程消费一次；目标名字由前端重新查目录。 */
    JSONObject takeClientLaunchTarget() {
        if (launchDeviceId == null || launchBotId == null) return null;
        JSONObject result = BotHostUiProtocol.object("deviceId", launchDeviceId, "botId", launchBotId);
        launchDeviceId = null;
        launchBotId = null;
        return result;
    }

    private void handleBackNavigation() {
        WebView wv = activeWebView;
        if (wv == null) {
            moveTaskToBack(true);
            return;
        }
        String js = "(function(){"
                + "try{"
                + "var req=new Event('app-back',{cancelable:true});"
                + "if(!window.dispatchEvent(req))return true;"
                + "if(document.querySelector('[role=\"dialog\"]:not([aria-hidden=\"true\"])')){"
                + "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));"
                + "return true;"
                + "}"
                + "return false;"
                + "}catch(e){return false;}"
                + "})()";
        wv.evaluateJavascript(js, handled -> {
            if (!"true".equals(handled)) {
                moveTaskToBack(true);
            }
        });
    }

    private float getDisplayDensity(View view) {
        if (view != null && view.getResources() != null) {
            return view.getResources().getDisplayMetrics().density;
        }
        return getResources().getDisplayMetrics().density;
    }

    private void removeDocumentStartScript() {
        ScriptHandler handler = documentStartScriptHandler;
        documentStartScriptHandler = null;
        if (handler != null) {
            try {
                handler.remove();
            } catch (RuntimeException e) {
                Log.w(TAG, "Failed to remove previous document-start insets script", e);
            }
        }
    }

    private void updateDocumentStartScript(WebView webView, int topCssPx, int bottomCssPx, int imeBottomCssPx) {
        if (webView == null || isDestroyed()) return;
        if (!documentStartScriptChecked) {
            documentStartScriptChecked = true;
            try {
                documentStartScriptSupported = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
            } catch (RuntimeException e) {
                documentStartScriptSupported = false;
                Log.w(TAG, "Failed to probe DOCUMENT_START_SCRIPT support", e);
            }
        }
        if (!documentStartScriptSupported) return;
        removeDocumentStartScript();
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                String script = WebViewInsetsState.buildDocumentStartScript(topCssPx, bottomCssPx, imeBottomCssPx);
                documentStartScriptHandler = WebViewCompat.addDocumentStartJavaScript(
                        webView, script, WebViewInsetsState.ALLOWED_ORIGINS);
                insetsState.markDocStartRegistered(topCssPx, bottomCssPx, imeBottomCssPx);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "Failed to register document-start insets script", e);
        }
    }

    private void seedInitialInsets(WebView webView) {
        if (webView == null) return;
        if (insetsState.hasInsets()) {
            if (insetsState.needsDocStartUpdate()) {
                updateDocumentStartScript(
                        webView,
                        insetsState.getSafeTopCssPx(),
                        insetsState.getSafeBottomCssPx(),
                        insetsState.getSettledImeBottomCssPx());
            }
            return;
        }
        View decorView = getWindow().getDecorView();
        float density = getDisplayDensity(decorView);
        WindowInsetsCompat rootInsets = decorView != null ? ViewCompat.getRootWindowInsets(decorView) : null;
        if (rootInsets != null) {
            Insets bars = rootInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = rootInsets.getInsets(WindowInsetsCompat.Type.ime());
            int top = WebViewInsetsState.pxToCssPx(bars.top, density);
            int bottom = WebViewInsetsState.pxToCssPx(bars.bottom, density);
            int imeBottom = WebViewInsetsState.pxToCssPx(ime.bottom, density);
            if (insetsState.seedInitialInsets(top, bottom, imeBottom, true)) {
                updateDocumentStartScript(webView, top, bottom, imeBottom);
            }
            return;
        }
        try {
            WindowInsets platformInsets = getWindowManager().getCurrentWindowMetrics().getWindowInsets();
            WindowInsetsCompat metricsInsets = decorView != null
                    ? WindowInsetsCompat.toWindowInsetsCompat(platformInsets, decorView)
                    : WindowInsetsCompat.toWindowInsetsCompat(platformInsets);
            Insets bars = metricsInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = metricsInsets.getInsets(WindowInsetsCompat.Type.ime());
            int top = WebViewInsetsState.pxToCssPx(bars.top, density);
            int bottom = WebViewInsetsState.pxToCssPx(bars.bottom, density);
            int imeBottom = WebViewInsetsState.pxToCssPx(ime.bottom, density);
            if (insetsState.seedInitialInsets(top, bottom, imeBottom, false)) {
                updateDocumentStartScript(webView, top, bottom, imeBottom);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "Unable to read initial WindowMetrics insets", e);
        }
    }

    private void installInsetsWebViewClient(WebView webView) {
        WebViewClient existing = webView.getWebViewClient();
        if (existing instanceof InsetsWebViewClient) return;
        webView.setWebViewClient(new InsetsWebViewClient(existing));
    }

    private void reInjectInsetsForPage(WebView webView, String url) {
        if (webView == null || webView != activeWebView || isDestroyed()) return;
        if (!WebViewInsetsState.isInjectablePageUrl(url)) return;
        WebViewInsetsState.PageSyncResult sync = insetsState.onPageReady();
        if (sync == null) return;
        webView.evaluateJavascript(
                WebViewInsetsState.buildInsetsSyncScript(
                        sync.safeTopCssPx, sync.safeBottomCssPx, sync.imeBottomCssPx, sync.dispatchImeChange),
                null);
    }

    /**
     * 剥离已由本 Activity 消费的 IME 与左右系统栏/刘海 insets 后再透传给子 {@link WebView}。
     *
     * <p>Android System WebView（Chromium M139+）会原生消费未剥离的 {@code Type.ime()} 来缩小
     * Visual Viewport 并在底部输入框聚焦时上推 {@code visualViewport.offsetTop}；与本页单一通道
     * {@code --ime-bottom} 叠加会产生 2 倍偏移（顶栏被顶出屏幕、输入框与键盘之间留出整块键盘高度空白）。
     * 通过 {@link WindowInsetsCompat.Builder} 将 {@code Type.ime()} 置零且不可见（而非返回
     * {@link WindowInsetsCompat#CONSUMED}），可确保子 WebView 仍正常收到回调并清除任何残留 IME 状态，
     * 同时保留上下安全区供 {@code env(safe-area-inset-*)} 兜底。
     */
    static WindowInsetsCompat stripImeInsetsForChild(
            WindowInsetsCompat windowInsets, int consumedLeftPx, int consumedRightPx) {
        if (windowInsets == null) return null;
        int left = Math.max(0, consumedLeftPx);
        int right = Math.max(0, consumedRightPx);
        WindowInsetsCompat adjusted = (left > 0 || right > 0)
                ? windowInsets.inset(left, 0, right, 0)
                : windowInsets;
        return new WindowInsetsCompat.Builder(adjusted)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setVisible(WindowInsetsCompat.Type.ime(), false)
                .build();
    }

    /**
     * targetSdk 36 全面屏沉浸：WebView 铺满整屏（top=0, bottom=0，不再因 IME 弹出压缩 WebView），
     * 状态栏/导航栏安全区（{@code --safe-area-inset-top/bottom}）与软键盘高度（{@code --ime-bottom}）
     * 通过单一 CSS 变量通道注入，并借助 {@code WindowInsetsAnimationCompat.Callback} 逐帧同步 IME 动画。
     */
    private void applyContentInsets() {
        View content = getWindow().getDecorView().findViewById(android.R.id.content);
        if (content == null || content == insetsTarget) return;
        insetsTarget = content;
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            float density = getDisplayDensity(view);
            int safeTopCssPx = WebViewInsetsState.pxToCssPx(bars.top, density);
            int safeBottomCssPx = WebViewInsetsState.pxToCssPx(bars.bottom, density);
            int imeBottomCssPx = WebViewInsetsState.pxToCssPx(ime.bottom, density);
            // WebView 始终铺满垂直全屏，仅左右让出横屏系统栏/刘海；键盘通过 --ime-bottom 单通道让位。
            view.setPadding(bars.left, 0, bars.right, 0);
            WebViewInsetsState.ApplyResult result =
                    insetsState.onApplyInsets(safeTopCssPx, safeBottomCssPx, imeBottomCssPx);
            WebView wv = activeWebView;
            if (wv != null && !isDestroyed()) {
                if (result.shouldUpdateDocStart) {
                    updateDocumentStartScript(
                            wv, result.safeTopCssPx, result.safeBottomCssPx, result.settledImeBottomCssPx);
                }
                if (result.shouldSyncFull) {
                    wv.evaluateJavascript(
                            WebViewInsetsState.buildInsetsSyncScript(
                                    result.safeTopCssPx,
                                    result.safeBottomCssPx,
                                    result.dispatchedImeBottomCssPx,
                                    result.dispatchImeChange),
                            null);
                } else if (result.shouldSyncImeOnly) {
                    wv.evaluateJavascript(
                            WebViewInsetsState.buildImeUpdateScript(result.dispatchedImeBottomCssPx),
                            null);
                }
            }
            return stripImeInsetsForChild(windowInsets, bars.left, bars.right);
        });
        ViewCompat.setWindowInsetsAnimationCallback(
                content,
                new WindowInsetsAnimationCompat.Callback(
                        WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP) {
                    @Override public void onPrepare(@NonNull WindowInsetsAnimationCompat animation) {
                        if ((animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0) {
                            insetsState.onImeAnimationPrepare(animation);
                        }
                    }

                    @NonNull @Override public WindowInsetsCompat onProgress(
                            @NonNull WindowInsetsCompat insets,
                            @NonNull List<WindowInsetsAnimationCompat> runningAnimations) {
                        boolean imeRunning = insetsState.isImeAnimating();
                        if (!imeRunning) {
                            for (WindowInsetsAnimationCompat anim : runningAnimations) {
                                if ((anim.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0) {
                                    imeRunning = true;
                                    break;
                                }
                            }
                        }
                        if (imeRunning) {
                            int imePx = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
                            int imeCssPx = WebViewInsetsState.pxToCssPx(imePx, getDisplayDensity(content));
                            WebViewInsetsState.ImeFrameResult frame =
                                    insetsState.onImeAnimationProgress(imeCssPx);
                            WebView wv = activeWebView;
                            if (frame.shouldDispatchIme && wv != null && !isDestroyed()) {
                                wv.evaluateJavascript(
                                        WebViewInsetsState.buildImeUpdateScript(frame.imeBottomCssPx),
                                        null);
                            }
                        }
                        return stripImeInsetsForChild(insets, 0, 0);
                    }

                    @Override public void onEnd(@NonNull WindowInsetsAnimationCompat animation) {
                        if ((animation.getTypeMask() & WindowInsetsCompat.Type.ime()) == 0) return;
                        WindowInsetsCompat rootInsets = ViewCompat.getRootWindowInsets(content);
                        Integer rootImeCssPx = rootInsets != null
                                ? WebViewInsetsState.pxToCssPx(
                                        rootInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom,
                                        getDisplayDensity(content))
                                : null;
                        WebViewInsetsState.ImeFrameResult settled =
                                insetsState.onImeAnimationEnd(animation, rootImeCssPx);
                        WebView wv = activeWebView;
                        if (wv != null && !isDestroyed()) {
                            if (settled.shouldUpdateDocStart) {
                                updateDocumentStartScript(
                                        wv,
                                        settled.safeTopCssPx,
                                        settled.safeBottomCssPx,
                                        settled.imeBottomCssPx);
                            }
                            if (settled.shouldDispatchIme) {
                                wv.evaluateJavascript(
                                        WebViewInsetsState.buildImeUpdateScript(settled.imeBottomCssPx),
                                        null);
                            }
                        }
                    }
                });
        ViewCompat.requestApplyInsets(content);
    }

    @Override public void onWebViewCreate(WebView webView) {
        super.onWebViewCreate(webView);
        removeDocumentStartScript();
        insetsState.resetForNewWebView();
        activeWebView = webView;
        applyAppearance();
        // 仅 debug 构建开启 WebView 检查；release 保持 false，不放松 CSP/Origin/TLS。
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        seedInitialInsets(webView);
        // 此回调早于 wry 的 setWebViewClient 与 setContentView，post 到队列首项（早于 loadUrlMainThread）
        // 包装 WebViewClient 并绑定内容容器 insets 监听。
        webView.post(() -> {
            if (activeWebView != webView || isDestroyed()) return;
            installInsetsWebViewClient(webView);
            applyContentInsets();
            seedInitialInsets(webView);
            applyAppearance();
        });
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        applyAppearance();
    }

    @Override public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyAppearance();
        if (insetsTarget != null) {
            ViewCompat.requestApplyInsets(insetsTarget);
        }
    }

    @Override protected void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override protected void onDestroy() {
        resumed = false;
        removeDocumentStartScript();
        if (insetsTarget != null) {
            ViewCompat.setOnApplyWindowInsetsListener(insetsTarget, null);
            ViewCompat.setWindowInsetsAnimationCallback(insetsTarget, null);
            insetsTarget = null;
        }
        insetsState.clearAnimations();
        activeWebView = null;
        unregisterReceiver(clientEvents);
        super.onDestroy();
        // SDK 清理完成后只终止隔离 UI 进程，避免 C 全局析构与绘图线程冲突。
        if (!isChangingConfigurations()) {
            Process.killProcess(Process.myPid());
        }
    }

    /** 插件原生前台校验：真实 resumed 且未结束/销毁。 */
    public boolean isUiResumed() {
        return resumed && !isFinishing() && !isDestroyed();
    }

    /**
     * 透明代理 Tauri 的 {@code RustWebViewClient}，保留所有拦截/路由/IPC URL 跟踪能力，
     * 并在页面提交绘制与加载完成时重注入安全区与 IME CSS 变量，防止页面重载后丢失。
     */
    private final class InsetsWebViewClient extends WebViewClient {
        private final WebViewClient delegate;

        InsetsWebViewClient(WebViewClient delegate) {
            this.delegate = delegate;
        }

        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return delegate != null
                    ? delegate.shouldOverrideUrlLoading(view, request)
                    : super.shouldOverrideUrlLoading(view, request);
        }

        @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (view == activeWebView && WebViewInsetsState.isInjectablePageUrl(url)) {
                insetsState.onPageStarted();
            }
            if (delegate != null) {
                delegate.onPageStarted(view, url, favicon);
            } else {
                super.onPageStarted(view, url, favicon);
            }
        }

        @Override public void onPageCommitVisible(WebView view, String url) {
            if (delegate != null) {
                delegate.onPageCommitVisible(view, url);
            } else {
                super.onPageCommitVisible(view, url);
            }
            reInjectInsetsForPage(view, url);
        }

        @Override public void onPageFinished(WebView view, String url) {
            if (delegate != null) {
                delegate.onPageFinished(view, url);
            } else {
                super.onPageFinished(view, url);
            }
            reInjectInsetsForPage(view, url);
        }

        @Override public void onLoadResource(WebView view, String url) {
            if (delegate != null) {
                delegate.onLoadResource(view, url);
            } else {
                super.onLoadResource(view, url);
            }
        }

        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return delegate != null
                    ? delegate.shouldInterceptRequest(view, request)
                    : super.shouldInterceptRequest(view, request);
        }

        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (delegate != null) {
                delegate.onReceivedError(view, request, error);
            } else {
                super.onReceivedError(view, request, error);
            }
        }

        @Override public void onReceivedHttpError(
                WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
            if (delegate != null) {
                delegate.onReceivedHttpError(view, request, errorResponse);
            } else {
                super.onReceivedHttpError(view, request, errorResponse);
            }
        }

        @Override public void onFormResubmission(WebView view, Message dontResend, Message resend) {
            if (delegate != null) {
                delegate.onFormResubmission(view, dontResend, resend);
            } else {
                super.onFormResubmission(view, dontResend, resend);
            }
        }

        @Override public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            if (delegate != null) {
                delegate.doUpdateVisitedHistory(view, url, isReload);
            } else {
                super.doUpdateVisitedHistory(view, url, isReload);
            }
        }

        @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            if (delegate != null) {
                delegate.onReceivedSslError(view, handler, error);
            } else {
                super.onReceivedSslError(view, handler, error);
            }
        }

        @Override public void onReceivedClientCertRequest(WebView view, ClientCertRequest request) {
            if (delegate != null) {
                delegate.onReceivedClientCertRequest(view, request);
            } else {
                super.onReceivedClientCertRequest(view, request);
            }
        }

        @Override public void onReceivedHttpAuthRequest(
                WebView view, HttpAuthHandler handler, String host, String realm) {
            if (delegate != null) {
                delegate.onReceivedHttpAuthRequest(view, handler, host, realm);
            } else {
                super.onReceivedHttpAuthRequest(view, handler, host, realm);
            }
        }

        @Override public boolean shouldOverrideKeyEvent(WebView view, KeyEvent event) {
            return delegate != null
                    ? delegate.shouldOverrideKeyEvent(view, event)
                    : super.shouldOverrideKeyEvent(view, event);
        }

        @Override public void onUnhandledKeyEvent(WebView view, KeyEvent event) {
            if (delegate != null) {
                delegate.onUnhandledKeyEvent(view, event);
            } else {
                super.onUnhandledKeyEvent(view, event);
            }
        }

        @Override public void onScaleChanged(WebView view, float oldScale, float newScale) {
            if (delegate != null) {
                delegate.onScaleChanged(view, oldScale, newScale);
            } else {
                super.onScaleChanged(view, oldScale, newScale);
            }
        }

        @Override public void onReceivedLoginRequest(
                WebView view, String realm, String account, String args) {
            if (delegate != null) {
                delegate.onReceivedLoginRequest(view, realm, account, args);
            } else {
                super.onReceivedLoginRequest(view, realm, account, args);
            }
        }

        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            return delegate != null
                    ? delegate.onRenderProcessGone(view, detail)
                    : super.onRenderProcessGone(view, detail);
        }

        @Override public void onSafeBrowsingHit(
                WebView view, WebResourceRequest request, int threatType, SafeBrowsingResponse callback) {
            if (delegate != null) {
                delegate.onSafeBrowsingHit(view, request, threatType, callback);
            } else {
                super.onSafeBrowsingHit(view, request, threatType, callback);
            }
        }
    }
}
