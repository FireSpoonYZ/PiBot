package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.Manifest;
import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Intent;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowNotificationManager;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class ClientUpdateNotificationsTest {
    private final Application app = RuntimeEnvironment.getApplication();
    private final ShadowNotificationManager notifications = shadowOf(app.getSystemService(NotificationManager.class));

    @Test public void notificationOpensTheClientAndDoesNotCarryInstallInputs() throws Exception {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
        ClientUpdateNotifications.show(app, "center-a", release(2));

        assertEquals(1, notifications.getAllNotifications().size());
        Notification notice = notifications.getAllNotifications().get(0);
        assertEquals(ClientUpdateNotifications.CHANNEL, notice.getChannelId());
        assertTrue((notice.flags & Notification.FLAG_AUTO_CANCEL) != 0);
        Intent open = shadowOf(notice.contentIntent).getSavedIntent();
        assertEquals(TauriMainActivity.class.getName(), open.getComponent().getClassName());
        assertEquals(ClientUpdateNotifications.ACTION_OPEN, open.getAction());
        assertNull(open.getExtras());
    }

    @Test public void aVersionIsRememberedOnlyAfterPostingAndANewerVersionCanStillNotify() throws Exception {
        ClientUpdateNotifications.show(app, "center-a", release(2));
        assertTrue(notifications.getAllNotifications().isEmpty());

        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
        ClientUpdateNotifications.show(app, "center-a", release(2));
        assertEquals(1, notifications.getAllNotifications().size());
        ClientUpdateNotifications.cancel(app);
        ClientUpdateNotifications.show(app, "center-a", release(2));
        assertTrue(notifications.getAllNotifications().isEmpty());

        ClientUpdateNotifications.show(app, "center-a", release(3));
        assertEquals(1, notifications.getAllNotifications().size());
    }

    private static JSONObject release(long versionCode) throws Exception {
        return new JSONObject().put("version", "1.0." + versionCode).put("versionCode", versionCode);
    }
}
