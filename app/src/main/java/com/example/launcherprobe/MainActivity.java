package com.example.launcherprobe;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** System launcher entry; the client UI lives in the dedicated Tauri process. */
public final class MainActivity extends Activity {
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        startActivity(new Intent(this, TauriMainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        finish();
    }
}
