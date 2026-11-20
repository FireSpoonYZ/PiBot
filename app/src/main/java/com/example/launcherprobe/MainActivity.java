package com.example.launcherprobe;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** System launcher entry; the client UI lives in the dedicated Tauri process. */
public final class MainActivity extends Activity {
    private static final int LIGHT_BG_COLOR = 0xfffaf9f6;
    private static final int DARK_BG_COLOR = 0xff191b19;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        AppAppearance appearance = AppAppearance.read(this);
        int bgColor = appearance.dark ? DARK_BG_COLOR : LIGHT_BG_COLOR;
        appearance.applySystemBars(this, bgColor);
        getWindow().getDecorView().setBackgroundColor(bgColor);
        startActivity(new Intent(this, TauriMainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP
                        | Intent.FLAG_ACTIVITY_NO_ANIMATION));
        finish();
    }
}
