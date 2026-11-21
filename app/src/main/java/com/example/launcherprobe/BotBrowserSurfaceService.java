package com.example.launcherprobe;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.hardware.display.DisplayManager;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Process;
import android.view.Display;

/** Private cross-process native browser surface transport. It never creates or navigates a tab. */
public final class BotBrowserSurfaceService extends Service {
    private void enforceCaller() {
        if (Binder.getCallingUid() != Process.myUid()) throw new SecurityException("Private browser surface");
        if (Build.VERSION.SDK_INT < 30) throw new UnsupportedOperationException("Native browser requires Android 11");
    }

    private final IBotBrowserSurface.Stub binder = new IBotBrowserSurface.Stub() {
        @Override public Bundle attach(Bundle request, IBinder hostToken, IBinder viewer) {
            enforceCaller();
            if (request == null || hostToken == null || viewer == null) throw new IllegalArgumentException("Missing surface identity");
            int width = request.getInt("width"), height = request.getInt("height");
            checkSize(width, height);
            Display display = getSystemService(DisplayManager.class).getDisplay(request.getInt("displayId", Display.DEFAULT_DISPLAY));
            if (display == null) throw new IllegalArgumentException("Display unavailable");
            Context context = createDisplayContext(display);
            try {
                Bundle reply = new Bundle();
                reply.putParcelable("surface", BotBrowserPresentation.attach(context,
                        request.getString("grantId", ""), request.getString("botId", ""),
                        request.getString("pageId", ""), hostToken, viewer, width, height));
                return reply;
            } catch (Exception error) { throw new IllegalStateException("Native browser grant unavailable", error); }
        }
        @Override public void resize(IBinder viewer, int width, int height) {
            enforceCaller(); checkSize(width, height);
            try { BotBrowserPresentation.onMain(() -> { BotBrowserPresentation.resize(viewer, width, height); return null; }); }
            catch (Exception error) { throw new IllegalStateException("Native browser resize failed", error); }
        }
        @Override public void detach(IBinder viewer) {
            enforceCaller();
            if (viewer == null) return;
            try { BotBrowserPresentation.onMain(() -> { BotBrowserPresentation.detach(viewer); return null; }); }
            catch (Exception error) { throw new IllegalStateException("Native browser detach failed", error); }
        }
        @Override public boolean isAttached(IBinder viewer) {
            enforceCaller();
            if (viewer == null) return false;
            try { return BotBrowserPresentation.onMain(() -> BotBrowserPresentation.isAttached(viewer)); }
            catch (Exception error) { return false; }
        }
    };

    private static void checkSize(int width, int height) {
        if (width < 1 || height < 1 || width > 8192 || height > 8192) throw new IllegalArgumentException("Invalid surface bounds");
    }

    @Override public IBinder onBind(Intent intent) { return binder; }
}
