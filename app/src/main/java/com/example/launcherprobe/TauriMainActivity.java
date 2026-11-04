package com.example.launcherprobe;

import android.graphics.Color;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import android.widget.Toast;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import org.json.JSONObject;

/**
 * M18 Tauri 界面入口：独立 {@code :tauri_ui} 进程，SDK 退出只结束本进程，
 * 默认进程的 Host/FGS 不受影响。
 */
public class TauriMainActivity extends TauriActivity {
    static {
        // 必须在本进程首个 WebView 创建前设置独立数据目录，避免多进程 WebView 冲突。
        WebView.setDataDirectorySuffix("tauri-ui");
    }

    private final BroadcastReceiver clientExit = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { finishAndRemoveTask(); }
    };
    private volatile boolean resumed;
    private View insetsTarget;
    private WebView activeWebView;
    private int lastSafeTopDp;
    private int lastSafeBottomDp;
    private String launchDeviceId;
    private String launchBotId;
    private static final String TARGET_DEVICE = "assistant_device_id";
    private static final String TARGET_BOT = "assistant_bot_id";

    @Override protected void onCreate(Bundle savedInstanceState) {
        if (savedInstanceState != null) {
            launchDeviceId = savedInstanceState.getString(TARGET_DEVICE);
            launchBotId = savedInstanceState.getString(TARGET_BOT);
        }
        captureLaunchTarget(getIntent());
        super.onCreate(savedInstanceState);
        registerReceiver(clientExit, new IntentFilter(BotClientService.ACTION_CLOSE_UI), Context.RECEIVER_NOT_EXPORTED);
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
        AppAppearance appearance = AppAppearance.read(this);
        int bgColor = appearance.dark ? 0xff191b19 : 0xfffaf9f6;
        appearance.applySystemBars(this, Color.TRANSPARENT);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(!appearance.dark);
            controller.setAppearanceLightNavigationBars(!appearance.dark);
        }
        // edge-to-edge 下窗口底色与前端主背景一致，避免首帧或边缘露白。
        getWindow().getDecorView().setBackgroundColor(bgColor);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                handleBackNavigation();
            }
        });
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        startClient();
        if (captureLaunchTarget(intent) && activeWebView != null) {
            activeWebView.evaluateJavascript("window.dispatchEvent(new Event('assistant-open-chat'))", null);
        }
    }

    private void startClient() {
        try {
            BotHostService.startClientFromActivity(this);
        } catch (RuntimeException failure) {
            Log.e("TauriMainActivity", "Client foreground service start failed", failure);
            Toast.makeText(this, "客户端启动失败，请重新打开应用", Toast.LENGTH_LONG).show();
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
                + "if(!window.dispatchEvent(new Event('composer-back',{cancelable:true})))return true;"
                + "var req=new Event('app-back',{cancelable:true});"
                + "if(!window.dispatchEvent(req))return true;"
                + "if(document.querySelector('[role=\"dialog\"]:not([aria-hidden=\"true\"])')){"
                + "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));"
                + "return true;"
                + "}"
                + "if((window.history.state&&window.history.state.idx)>0){window.history.back();return true;}"
                + "return false;"
                + "}catch(e){return false;}"
                + "})()";
        wv.evaluateJavascript(js, handled -> {
            if (!"true".equals(handled)) {
                moveTaskToBack(true);
            }
        });
    }

    private void syncSafeAreaCss() {
        WebView wv = activeWebView;
        if (wv == null) return;
        String js = "if(document.documentElement){"
                + "document.documentElement.style.setProperty('--safe-area-inset-top','" + lastSafeTopDp + "px');"
                + "document.documentElement.style.setProperty('--safe-area-inset-bottom','" + lastSafeBottomDp + "px');"
                + "}";
        wv.evaluateJavascript(js, null);
    }

    /**
     * targetSdk 36 全面屏沉浸：WebView 铺满整屏（top=0, bottom=ime.bottom），
     * 状态栏与手势导航栏安全区通过 CSS 变量单次注入前端，避免原生 padding 与 WebView safe-area 叠加。
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
            float density = view.getResources().getDisplayMetrics().density;
            lastSafeTopDp = Math.round(bars.top / Math.max(1f, density));
            lastSafeBottomDp = ime.bottom > 0 ? 0 : Math.round(bars.bottom / Math.max(1f, density));
            // 仅在软键盘弹出时让出底部 IME 高度，其余时间 WebView 延伸至状态栏与底部导航栏全屏区域。
            view.setPadding(bars.left, 0, bars.right, ime.bottom);
            syncSafeAreaCss();
            if (activeWebView != null) {
                activeWebView.postDelayed(this::syncSafeAreaCss, 180);
            }
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(content);
    }

    @Override public void onWebViewCreate(WebView webView) {
        super.onWebViewCreate(webView);
        activeWebView = webView;
        AppAppearance appearance = AppAppearance.read(this);
        webView.setBackgroundColor(appearance.dark ? 0xff191b19 : 0xfffaf9f6);
        // 仅 debug 构建开启 WebView 检查；release 保持 false，不放松 CSP/Origin/TLS。
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        // 此回调早于 Rust 的 setContentView（见上），post 到当前调用栈之后再绑定真实内容容器。
        webView.post(this::applyContentInsets);
        webView.postDelayed(this::syncSafeAreaCss, 350);
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
    }

    @Override protected void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override protected void onDestroy() {
        resumed = false;
        activeWebView = null;
        unregisterReceiver(clientExit);
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
}
