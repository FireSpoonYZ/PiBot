package com.example.launcherprobe;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.view.SurfaceControlViewHost;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Supplier;

/** Tauri-process viewport for the actual Host WebView; no URL load or second cookie store. */
final class BotBrowserNativeOverlay {
    private final Activity activity;
    private final Supplier<WebView> webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private IBotBrowserSurface service;
    private IBinder viewer;
    private SurfaceView surface;
    private FrameLayout container;
    private SurfaceControlViewHost.SurfacePackage surfacePackage;
    private boolean bound, attaching, attached, visible;
    private int sessionId, attachGeneration, width = 1, height = 1;
    private String grantId, botId, pageId;
    private String phase = "idle";
    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            service = IBotBrowserSurface.Stub.asInterface(binder);
            attach();
        }
        @Override public void onServiceDisconnected(ComponentName name) {
            service = null;
            phase = "error";
            if (container != null) container.setVisibility(View.INVISIBLE);
        }
    };

    BotBrowserNativeOverlay(Activity activity, Supplier<WebView> webView) {
        this.activity = activity;
        this.webView = webView;
    }

    JSONObject open(JSONObject params) throws Exception {
        if (Build.VERSION.SDK_INT < 30) return status();
        String nextGrant = params.getString("grantId");
        String nextBot = params.getString("botId"), nextPage = params.getString("pageId");
        if (nextGrant.length() < 16 || nextGrant.length() > 256 || nextBot.isEmpty() || nextPage.isEmpty()) {
            throw new IllegalArgumentException("Missing native grant");
        }
        if (nextGrant.equals(grantId) && nextBot.equals(botId) && nextPage.equals(pageId)) {
            layout(params);
            return status();
        }
        close();
        sessionId++;
        grantId = nextGrant; botId = nextBot; pageId = nextPage;
        viewer = new Binder();
        phase = "connecting";
        container = new FrameLayout(activity);
        surface = new SurfaceView(activity);
        surface.setZOrderOnTop(true);
        container.addView(surface, new FrameLayout.LayoutParams(-1, -1));
        ((ViewGroup) activity.findViewById(android.R.id.content)).addView(container, new FrameLayout.LayoutParams(1, 1));
        surface.getHolder().addCallback(new SurfaceHolder.Callback() {
            @Override public void surfaceCreated(SurfaceHolder holder) { attach(); }
            @Override public void surfaceChanged(SurfaceHolder holder, int format, int w, int h) { attach(); }
            @Override public void surfaceDestroyed(SurfaceHolder holder) { detach(); }
        });
        layout(params);
        bound = activity.bindService(new Intent(activity, BotBrowserSurfaceService.class), connection, Context.BIND_AUTO_CREATE);
        if (!bound) phase = "error";
        return status();
    }

    void layout(JSONObject params) throws Exception {
        if (container == null) return;
        JSONObject rect = params.getJSONObject("rect");
        double dpr = params.optDouble("dpr", 1);
        double x = rect.getDouble("x"), y = rect.getDouble("y");
        double w = rect.getDouble("width"), h = rect.getDouble("height");
        if (!Double.isFinite(dpr) || dpr <= 0 || dpr > 8 || !Double.isFinite(x) || !Double.isFinite(y)
                || !Double.isFinite(w) || !Double.isFinite(h) || w < 0 || h < 0 || w * dpr > 8192 || h * dpr > 8192) {
            throw new IllegalArgumentException("Invalid native viewport bounds");
        }
        visible = params.optBoolean("visible", true) && w > 0 && h > 0;
        if (!visible) { container.setVisibility(View.INVISIBLE); detach(); return; }
        WebView host = webView.get();
        if (host == null) { close(); return; }
        ViewGroup content = activity.findViewById(android.R.id.content);
        int[] webPosition = new int[2], contentPosition = new int[2];
        host.getLocationInWindow(webPosition); content.getLocationInWindow(contentPosition);
        width = Math.max(1, (int) Math.round(w * dpr)); height = Math.max(1, (int) Math.round(h * dpr));
        FrameLayout.LayoutParams bounds = new FrameLayout.LayoutParams(width, height);
        bounds.leftMargin = webPosition[0] - contentPosition[0] - content.getPaddingLeft() + (int) Math.round(x * dpr);
        bounds.topMargin = webPosition[1] - contentPosition[1] - content.getPaddingTop() + (int) Math.round(y * dpr);
        container.setLayoutParams(bounds);
        container.setVisibility(View.VISIBLE);
        IBotBrowserSurface remote = service; IBinder token = viewer;
        int nextWidth = width, nextHeight = height;
        if (attached && remote != null) worker.execute(() -> {
            try { remote.resize(token, nextWidth, nextHeight); } catch (Exception ignored) { }
        });
        else attach();
    }

    private void attach() {
        if (Build.VERSION.SDK_INT < 30 || !visible || attached || attaching || service == null || surface == null
                || !surface.getHolder().getSurface().isValid() || surface.getHostToken() == null) return;
        attaching = true;
        phase = "connecting";
        int generation = sessionId, attempt = ++attachGeneration;
        IBotBrowserSurface remote = service;
        IBinder token = new Binder(), hostToken = surface.getHostToken();
        viewer = token;
        Bundle args = new Bundle();
        args.putString("grantId", grantId); args.putString("botId", botId); args.putString("pageId", pageId);
        args.putInt("width", width); args.putInt("height", height);
        args.putInt("displayId", surface.getDisplay().getDisplayId());
        worker.execute(() -> {
            try {
                Bundle result = remote.attach(args, hostToken, token);
                SurfaceControlViewHost.SurfacePackage incoming = result.getParcelable("surface");
                main.post(() -> {
                    if (generation != sessionId || attempt != attachGeneration || surface == null || !visible) {
                        if (incoming != null) incoming.release();
                        if (!worker.isShutdown()) worker.execute(() -> { try { remote.detach(token); } catch (Exception ignored) { } });
                        return;
                    }
                    attaching = false;
                    if (incoming == null) { phase = "error"; return; }
                    surfacePackage = incoming;
                    surface.setChildSurfacePackage(incoming);
                    attached = true;
                    phase = "ready";
                    watch(generation, token, remote);
                });
            } catch (Exception error) {
                main.post(() -> {
                    if (generation == sessionId && attempt == attachGeneration) {
                        attaching = false; phase = "error";
                        if (container != null) container.setVisibility(View.INVISIBLE);
                    }
                });
            }
        });
    }

    private void watch(int generation, IBinder token, IBotBrowserSurface remote) {
        main.postDelayed(() -> {
            if (generation != sessionId || token != viewer || !attached || worker.isShutdown()) return;
            worker.execute(() -> {
                boolean live;
                try { live = remote.isAttached(token); } catch (Exception error) { live = false; }
                boolean current = live;
                main.post(() -> {
                    if (generation != sessionId || token != viewer || !attached) return;
                    if (!current) {
                        phase = "error";
                        if (container != null) container.setVisibility(View.INVISIBLE);
                        detach();
                    } else watch(generation, token, remote);
                });
            });
        }, 500);
    }

    private void detach() {
        IBotBrowserSurface remote = service; IBinder token = viewer;
        attachGeneration++;
        attaching = false;
        attached = false;
        if (remote != null && token != null && !worker.isShutdown()) worker.execute(() -> { try { remote.detach(token); } catch (Exception ignored) { } });
        if (surfacePackage != null) { surfacePackage.release(); surfacePackage = null; }
    }

    boolean isSession(int id) { return container != null && id == sessionId; }

    JSONObject status() throws Exception {
        return new JSONObject().put("supported", Build.VERSION.SDK_INT >= 30)
                .put("sessionId", sessionId).put("phase", phase);
    }

    void close() {
        sessionId++;
        visible = false;
        detach();
        attaching = false;
        if (container != null) {
            container.setVisibility(View.INVISIBLE);
            ((ViewGroup) container.getParent()).removeView(container);
        }
        container = null; surface = null; grantId = null;
        if (bound) activity.unbindService(connection);
        bound = false; service = null; viewer = null; phase = "idle";
    }

    void destroy() { close(); worker.shutdown(); }
}
