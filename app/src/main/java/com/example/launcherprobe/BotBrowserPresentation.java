package com.example.launcherprobe;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.SurfaceControlViewHost;
import android.view.View;
import android.widget.FrameLayout;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/** Default-process registry. UI callers can consume grants, never issue or renew them. */
final class BotBrowserPresentation {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Map<String, Grant> GRANTS = new HashMap<>();

    private static final class Grant {
        final String id, owner, botId, pageId;
        final BotBrowserManager.WebViewTabHandle tab;
        final BooleanSupplier pageActive;
        volatile long deadline;
        SurfaceControlViewHost host;
        FrameLayout root;
        IBinder viewer;
        IBinder.DeathRecipient death;

        Grant(String id, String owner, String botId, String pageId,
                BotBrowserManager.WebViewTabHandle tab, BooleanSupplier pageActive) {
            this.id = id; this.owner = owner; this.botId = botId; this.pageId = pageId; this.tab = tab;
            this.pageActive = pageActive;
        }

        boolean valid() {
            return deadline > SystemClock.elapsedRealtime() && !tab.destroyed && pageActive.getAsBoolean();
        }
    }

    static <T> T onMain(Callable<T> action) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) return action.call();
        FutureTask<T> task = new FutureTask<>(action);
        MAIN.post(task);
        try { return task.get(5, TimeUnit.SECONDS); }
        catch (Exception error) { task.cancel(false); throw error; }
    }

    static void grant(String owner, String botId, String pageId,
            BotBrowserManager.WebViewTabHandle tab, String id, long expiresAt, BooleanSupplier pageActive) throws Exception {
        long ttl = expiresAt - System.currentTimeMillis();
        if (Build.VERSION.SDK_INT < 30 || id.length() < 16 || id.length() > 256 || ttl <= 0 || ttl > 5000) {
            throw new IllegalArgumentException("Invalid native presentation grant");
        }
        onMain(() -> {
            Grant grant = GRANTS.get(id);
            if (grant != null && (!grant.owner.equals(owner) || !grant.pageId.equals(pageId) || grant.tab != tab)) {
                throw new SecurityException("Grant belongs to another page");
            }
            // A new lease/page replaces the previous native input authority for this Bot.
            for (Grant other : GRANTS.values().toArray(new Grant[0])) {
                if (other.owner.equals(owner) && !other.id.equals(id)) remove(other);
            }
            if (grant == null) {
                grant = new Grant(id, owner, botId, pageId, tab, pageActive);
                GRANTS.put(id, grant);
            }
            grant.deadline = SystemClock.elapsedRealtime() + Math.max(0, expiresAt - System.currentTimeMillis());
            Grant current = grant;
            MAIN.postDelayed(() -> {
                if (GRANTS.get(id) == current && !current.valid()) remove(current);
            }, ttl + 1);
            return null;
        });
    }

    static void revoke(String owner, String id) throws Exception {
        onMain(() -> {
            for (Grant grant : GRANTS.values().toArray(new Grant[0])) {
                if (grant.owner.equals(owner) && (id.isEmpty() || grant.id.equals(id))) remove(grant);
            }
            return null;
        });
    }

    static void destroy(BotBrowserManager.WebViewTabHandle tab) {
        for (Grant grant : GRANTS.values().toArray(new Grant[0])) {
            if (grant.tab == tab) remove(grant);
        }
    }

    static SurfaceControlViewHost.SurfacePackage attach(Context context, String id, String botId,
            String pageId, IBinder hostToken, IBinder viewer, int width, int height) throws Exception {
        return onMain(() -> {
            Grant grant = GRANTS.get(id);
            if (grant == null || !grant.valid() || !grant.botId.equals(botId) || !grant.pageId.equals(pageId)) {
                throw new SecurityException("Native presentation grant expired or mismatched");
            }
            detach(viewer);
            detachGrant(grant);
            grant.viewer = viewer;
            grant.death = () -> MAIN.post(() -> detach(viewer));
            viewer.linkToDeath(grant.death, 0);
            FrameLayout root = new FrameLayout(context) {
                @Override public boolean dispatchTouchEvent(MotionEvent event) {
                    return grant.valid() && super.dispatchTouchEvent(event);
                }
                @Override public boolean dispatchKeyEvent(KeyEvent event) {
                    return grant.valid() && super.dispatchKeyEvent(event);
                }
            };
            grant.root = root;
            grant.tab.webView.setEnabled(true);
            grant.tab.webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
            root.addView(grant.tab.webView, new FrameLayout.LayoutParams(-1, -1));
            grant.host = new SurfaceControlViewHost(context, context.getDisplay(), hostToken);
            grant.tab.width = width;
            grant.tab.height = height;
            grant.host.setView(root, width, height);
            watch(grant, grant.host);
            return grant.host.getSurfacePackage();
        });
    }

    private static void watch(Grant grant, SurfaceControlViewHost host) {
        MAIN.postDelayed(() -> {
            if (GRANTS.get(grant.id) != grant || grant.host != host) return;
            if (!grant.valid()) remove(grant);
            else watch(grant, host);
        }, 100);
    }

    static void resize(IBinder viewer, int width, int height) {
        for (Grant grant : GRANTS.values()) {
            if (viewer.equals(grant.viewer) && grant.valid() && grant.host != null) {
                grant.tab.width = width;
                grant.tab.height = height;
                grant.host.relayout(width, height);
            }
        }
    }

    static void detach(IBinder viewer) {
        for (Grant grant : GRANTS.values()) if (viewer.equals(grant.viewer)) detachGrant(grant);
    }

    static boolean isAttached(IBinder viewer) {
        for (Grant grant : GRANTS.values()) {
            if (viewer.equals(grant.viewer) && grant.host != null && grant.valid()) return true;
        }
        return false;
    }

    private static void remove(Grant grant) {
        GRANTS.remove(grant.id);
        grant.deadline = 0;
        detachGrant(grant);
    }

    private static void detachGrant(Grant grant) {
        if (grant.root != null) {
            grant.tab.webView.clearFocus();
            grant.root.removeView(grant.tab.webView);
            grant.tab.webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
            grant.root = null;
        }
        if (grant.host != null) { grant.host.release(); grant.host = null; }
        if (grant.viewer != null && grant.death != null) grant.viewer.unlinkToDeath(grant.death, 0);
        grant.viewer = null;
        grant.death = null;
    }
}
