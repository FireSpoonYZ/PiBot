package com.example.launcherprobe;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;
import android.view.View;

/** Theme shared by the client UI and Android system bars. */
final class AppAppearance {
    final boolean dark;

    private AppAppearance(boolean dark) { this.dark = dark; }

    static AppAppearance read(Context context) {
        String value = context.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("theme", "system");
        boolean systemDark = (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        return new AppAppearance(value.equals("dark") || (value.equals("system") && systemDark));
    }

    void applySystemBars(Activity activity, int color) {
        activity.getWindow().setStatusBarColor(color);
        activity.getWindow().setNavigationBarColor(color);
        activity.getWindow().setStatusBarContrastEnforced(false);
        activity.getWindow().setNavigationBarContrastEnforced(false);
        activity.getWindow().getDecorView().setSystemUiVisibility(dark ? 0
                : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    }
}
