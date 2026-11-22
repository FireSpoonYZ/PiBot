package com.example.launcherprobe;

import android.os.Bundle;

/** Same-UID transport for an existing Host WebView. Grants originate from the leased Host lane. */
interface IBotBrowserSurface {
    Bundle attach(in Bundle request, IBinder hostToken, IBinder viewer);
    void resize(IBinder viewer, int width, int height);
    void detach(IBinder viewer);
    boolean isAttached(IBinder viewer);
}
