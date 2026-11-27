package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.os.PersistableBundle;
import android.os.Process;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Verifies security boundaries, profile/lock/permission guards, pre-online baseline suppression,
 * and shared {@link ClipboardSyncController} filtering inside {@link ClipboardSyncShizukuService}
 * and {@link ClipboardSyncShizukuAdapter}.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class ClipboardSyncShizukuTest {

    private static final int APP_UID = 10_234;

    private static final class TimestampedDescription extends ClipDescription {
        private final long timestamp;

        TimestampedDescription(CharSequence label, String[] mimeTypes, long timestamp) {
            super(label, mimeTypes);
            this.timestamp = timestamp;
        }

        @Override
        public long getTimestamp() {
            return timestamp;
        }
    }

    private static final class FakeClipboardBackend implements ClipboardSyncShizukuService.ClipboardBackend {
        volatile ClipData primaryClip;
        volatile boolean throwSecurityOnRead;
        final AtomicInteger clipReadCalls = new AtomicInteger();
        ClipboardManager.OnPrimaryClipChangedListener registeredListener;

        @Override
        public boolean addListener(ClipboardManager.OnPrimaryClipChangedListener listener) {
            registeredListener = listener;
            return true;
        }

        @Override
        public void removeListener(ClipboardManager.OnPrimaryClipChangedListener listener) {
            if (registeredListener == listener) {
                registeredListener = null;
            }
        }

        @Override
        public ClipDescription getPrimaryClipDescription() {
            if (throwSecurityOnRead) {
                throw new SecurityException("OEM denied background clipboard metadata");
            }
            ClipData clip = primaryClip;
            return clip == null ? null : clip.getDescription();
        }

        @Override
        public ClipData getPrimaryClip() {
            clipReadCalls.incrementAndGet();
            if (throwSecurityOnRead) {
                throw new SecurityException("OEM denied background clipboard read");
            }
            return primaryClip;
        }

        void fireChanged() {
            ClipboardManager.OnPrimaryClipChangedListener listener = registeredListener;
            if (listener != null) {
                listener.onPrimaryClipChanged();
            }
        }
    }

    private static final class RecordingCallback extends IClipboardSyncShizukuCallback.Stub {
        final AtomicInteger changeCount = new AtomicInteger();
        final AtomicInteger unavailableCount = new AtomicInteger();

        @Override
        public void onPrimaryClipChanged() {
            changeCount.incrementAndGet();
        }

        @Override
        public void onListenerUnavailable() {
            unavailableCount.incrementAndGet();
        }
    }

    private static ClipData plainClip(String label, String text, long timestampMs) {
        TimestampedDescription desc = new TimestampedDescription(
                label, new String[]{ClipDescription.MIMETYPE_TEXT_PLAIN}, timestampMs);
        return new ClipData(desc, new ClipData.Item(text));
    }

    @Test
    public void enforcesAppCallingUidAndDestroyAllowlist() {
        AtomicInteger callerUid = new AtomicInteger(APP_UID + 1);
        FakeClipboardBackend backend = new FakeClipboardBackend();
        ClipboardSyncShizukuService service = new ClipboardSyncShizukuService(
                APP_UID,
                Process.SHELL_UID,
                callerUid::get,
                () -> true,
                () -> true,
                () -> true,
                () -> false,
                backend,
                Runnable::run,
                false);
        RecordingCallback callback = new RecordingCallback();

        try {
            service.startListening(callback);
            fail("expected SecurityException for foreign UID on startListening");
        } catch (SecurityException expected) {
        }
        try {
            service.stopListening();
            fail("expected SecurityException for foreign UID on stopListening");
        } catch (SecurityException expected) {
        }
        try {
            service.readFilteredPlainText();
            fail("expected SecurityException for foreign UID on readFilteredPlainText");
        } catch (SecurityException expected) {
        }
        try {
            service.destroy();
            fail("expected SecurityException for foreign UID on destroy");
        } catch (SecurityException expected) {
        }

        // Destroy permits appUid, shell UID, and root UID.
        callerUid.set(Process.SHELL_UID);
        service.destroy();
        callerUid.set(0);
        service.destroy();
        callerUid.set(APP_UID);
        service.destroy();
    }

    @Test
    public void validatesCallbackCallingUidStrictly() {
        assertTrue(ClipboardSyncShizukuAdapter.isAllowedShizukuCallbackUid(Process.SHELL_UID, Process.SHELL_UID));
        assertTrue(ClipboardSyncShizukuAdapter.isAllowedShizukuCallbackUid(0, 0));
        assertFalse(ClipboardSyncShizukuAdapter.isAllowedShizukuCallbackUid(Process.SHELL_UID, 0));
        assertFalse(ClipboardSyncShizukuAdapter.isAllowedShizukuCallbackUid(0, Process.SHELL_UID));
        assertFalse(ClipboardSyncShizukuAdapter.isAllowedShizukuCallbackUid(APP_UID, Process.SHELL_UID));
        assertFalse(ClipboardSyncShizukuAdapter.isAllowedShizukuCallbackUid(10_999, -1));
    }

    @Test
    public void respectsProfileLockedScreenPermissionAndAppOps() {
        FakeClipboardBackend backend = new FakeClipboardBackend();
        RecordingCallback callback = new RecordingCallback();

        // Cross-profile (work profile user 10 vs shell user 0) must be refused.
        int workProfileAppUid = 10 * ClipboardSyncShizukuService.PER_USER_RANGE + 234;
        ClipboardSyncShizukuService crossProfile = new ClipboardSyncShizukuService(
                workProfileAppUid,
                Process.SHELL_UID,
                () -> workProfileAppUid,
                () -> true,
                () -> true,
                () -> true,
                () -> false,
                backend,
                Runnable::run,
                false);
        assertFalse(crossProfile.startListening(callback));

        // Missing READ_CLIPBOARD_IN_BACKGROUND permission must be refused.
        ClipboardSyncShizukuService noPerm = new ClipboardSyncShizukuService(
                APP_UID,
                Process.SHELL_UID,
                () -> APP_UID,
                () -> false,
                () -> true,
                () -> true,
                () -> false,
                backend,
                Runnable::run,
                false);
        assertFalse(noPerm.startListening(callback));

        // Denied AppOp must be refused.
        ClipboardSyncShizukuService noAppOp = new ClipboardSyncShizukuService(
                APP_UID,
                Process.SHELL_UID,
                () -> APP_UID,
                () -> true,
                () -> false,
                () -> true,
                () -> false,
                backend,
                Runnable::run,
                false);
        assertFalse(noAppOp.startListening(callback));

        // Locked user (direct boot) must be refused.
        ClipboardSyncShizukuService lockedUser = new ClipboardSyncShizukuService(
                APP_UID,
                Process.SHELL_UID,
                () -> APP_UID,
                () -> true,
                () -> true,
                () -> false,
                () -> false,
                backend,
                Runnable::run,
                false);
        assertFalse(lockedUser.startListening(callback));

        // Screen locked: listener may remain armed, but changes and reads are suppressed while locked.
        AtomicBoolean screenLocked = new AtomicBoolean(true);
        ClipboardSyncShizukuService service = new ClipboardSyncShizukuService(
                APP_UID,
                Process.SHELL_UID,
                () -> APP_UID,
                () -> true,
                () -> true,
                () -> true,
                screenLocked::get,
                backend,
                Runnable::run,
                false);
        assertTrue(service.startListening(callback));
        backend.primaryClip = plainClip("user", "while-locked", 2_000L);
        backend.fireChanged();
        assertEquals(0, callback.changeCount.get());
        assertNull(service.readFilteredPlainText());

        // Unlock -> reads succeed.
        screenLocked.set(false);
        backend.fireChanged();
        assertEquals(1, callback.changeCount.get());
        assertEquals("while-locked", service.readFilteredPlainText());
    }

    @Test
    public void skipsPreExistingOwnShowerAndOversizedClipsButAllowsSensitiveText() {
        FakeClipboardBackend backend = new FakeClipboardBackend();
        backend.primaryClip = plainClip("old", "pre-existing-before-online", 1_000L);
        RecordingCallback callback = new RecordingCallback();

        ClipboardSyncShizukuService service = new ClipboardSyncShizukuService(
                APP_UID,
                Process.SHELL_UID,
                () -> APP_UID,
                () -> true,
                () -> true,
                () -> true,
                () -> false,
                backend,
                Runnable::run,
                false);

        assertTrue(service.startListening(callback));
        assertEquals("startListening must only inspect metadata, never read clip payload", 0, backend.clipReadCalls.get());

        // Pre-existing clip at baseline timestamp 1_000L must never notify or be read/published.
        backend.fireChanged();
        assertEquals(0, callback.changeCount.get());
        assertNull(service.readFilteredPlainText());
        assertEquals(0, backend.clipReadCalls.get());

        // Fresh clip at 2_000L notifies and reads once; duplicate read for same timestamp is suppressed.
        backend.primaryClip = plainClip("user", "fresh-user-text", 2_000L);
        backend.fireChanged();
        assertEquals(1, callback.changeCount.get());
        assertEquals("fresh-user-text", service.readFilteredPlainText());
        assertNull(service.readFilteredPlainText());

        // Own incoming sync clip must be filtered before waking the app and never bounce.
        ClipData ownIncoming = ClipboardSyncController.buildIncomingClip("from-remote-peer");
        backend.primaryClip = ownIncoming;
        backend.fireChanged();
        assertEquals(1, callback.changeCount.get());
        assertNull(service.readFilteredPlainText());

        // Shower "pibot" label must be rejected.
        backend.primaryClip = plainClip(ClipboardSyncController.SHOWER_CLIP_LABEL, "shower-text", 3_000L);
        backend.fireChanged();
        assertEquals(1, callback.changeCount.get());
        assertNull(service.readFilteredPlainText());

        // A sensitive plain-text clip is still captured.
        ClipData sensitive = plainClip("test-code", "123456", 4_000L);
        PersistableBundle extras = new PersistableBundle();
        extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
        sensitive.getDescription().setExtras(extras);
        backend.primaryClip = sensitive;
        backend.fireChanged();
        assertEquals(2, callback.changeCount.get());
        assertEquals("123456", service.readFilteredPlainText());

        // Oversized > 64 KiB UTF-8 clip must be rejected.
        backend.primaryClip = plainClip("big", "x".repeat(ClipboardSyncController.MAX_TEXT_BYTES + 1), 5_000L);
        assertNull(service.readFilteredPlainText());
    }

    @Test
    public void securityExceptionDuringReadNotifiesUnavailableAndStopsListener() {
        FakeClipboardBackend backend = new FakeClipboardBackend();
        RecordingCallback callback = new RecordingCallback();
        ClipboardSyncShizukuService service = new ClipboardSyncShizukuService(
                APP_UID,
                Process.SHELL_UID,
                () -> APP_UID,
                () -> true,
                () -> true,
                () -> true,
                () -> false,
                backend,
                Runnable::run,
                false);

        assertTrue(service.startListening(callback));
        backend.throwSecurityOnRead = true;
        assertNull(service.readFilteredPlainText());
        assertNull("OS listener must be unregistered on security denial", backend.registeredListener);
        assertEquals(1, callback.unavailableCount.get());
    }
}
