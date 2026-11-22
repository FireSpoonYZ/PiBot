package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import androidx.core.graphics.Insets;
import androidx.core.view.WindowInsetsCompat;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Verifies that {@link TauriMainActivity#stripImeInsetsForChild} strips IME and already-applied
 * horizontal insets before forwarding to the child WebView so Chromium M139+ does not shrink
 * {@code visualViewport} on top of {@code --ime-bottom}, while preserving vertical safe areas and
 * keeping the insets non-consumed so downstream WebView updates still fire.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class TauriMainActivityInsetsTest {

    @Test
    public void stripsImeAndConsumedHorizontalInsetsWhilePreservingVerticalSystemBars() {
        WindowInsetsCompat original = new WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.of(48, 108, 24, 72))
                .setVisible(WindowInsetsCompat.Type.systemBars(), true)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, 730))
                .setVisible(WindowInsetsCompat.Type.ime(), true)
                .build();

        WindowInsetsCompat forwarded = TauriMainActivity.stripImeInsetsForChild(original, 48, 24);
        assertNotNull(forwarded);
        assertFalse(forwarded.isConsumed());
        assertEquals(Insets.NONE, forwarded.getInsets(WindowInsetsCompat.Type.ime()));
        assertFalse(forwarded.isVisible(WindowInsetsCompat.Type.ime()));
        assertEquals(
                Insets.of(0, 108, 0, 72),
                forwarded.getInsets(WindowInsetsCompat.Type.systemBars()));
    }

    @Test
    public void handlesNullAndPortraitZeroHorizontalPadding() {
        assertNull(TauriMainActivity.stripImeInsetsForChild(null, 0, 0));

        WindowInsetsCompat portrait = new WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.of(0, 96, 0, 64))
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, 680))
                .setVisible(WindowInsetsCompat.Type.ime(), true)
                .build();

        WindowInsetsCompat forwarded = TauriMainActivity.stripImeInsetsForChild(portrait, 0, 0);
        assertNotNull(forwarded);
        assertEquals(Insets.NONE, forwarded.getInsets(WindowInsetsCompat.Type.ime()));
        assertFalse(forwarded.isVisible(WindowInsetsCompat.Type.ime()));
        assertEquals(
                Insets.of(0, 96, 0, 64),
                forwarded.getInsets(WindowInsetsCompat.Type.systemBars()));
    }
}
