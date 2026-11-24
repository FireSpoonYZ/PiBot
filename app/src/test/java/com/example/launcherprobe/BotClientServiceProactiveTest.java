package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.Manifest;
import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowNotificationManager;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class BotClientServiceProactiveTest {
    private static final String VISIBILITY_OWNER = "test-ui-owner";
    private final Application app = RuntimeEnvironment.getApplication();
    private final ShadowNotificationManager notifications =
            shadowOf(app.getSystemService(NotificationManager.class));

    @After
    public void tearDown() {
        BotClientService.clearVisibility(VISIBILITY_OWNER);
    }

    @Test
    public void proactiveGoogleBoardResultPostsPrivateNotificationWithExactBotDeepLink() throws Exception {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);

        String deviceId = "dev/alpha";
        String botId = "bot-mail";
        JSONObject board = boardSnapshot(botId, new JSONObject()
                .put("id", "42")
                .put("kind", "proactive-google")
                .put("summary", "有新的邮件或日程待查看")
                .put("completedAt", "2026-11-24T10:00:00Z"));

        assertTrue(BotClientService.evaluateProactiveBoardResult(app, deviceId, botId, "邮件助理", board));

        assertEquals(1, notifications.getAllNotifications().size());
        Notification notice = notifications.getAllNotifications().get(0);
        assertEquals(BotClientService.PROACTIVE_CHANNEL, notice.getChannelId());
        assertEquals(Notification.VISIBILITY_PRIVATE, notice.visibility);
        assertTrue((notice.flags & Notification.FLAG_AUTO_CANCEL) != 0);
        assertEquals("邮件助理", String.valueOf(notice.extras.getCharSequence(Notification.EXTRA_TITLE)));
        assertEquals("有新的邮件或日程待查看", String.valueOf(notice.extras.getCharSequence(Notification.EXTRA_TEXT)));

        Intent open = shadowOf(notice.contentIntent).getSavedIntent();
        assertNotNull(open);
        assertEquals(TauriMainActivity.class.getName(), open.getComponent().getClassName());
        assertEquals(
                Uri.parse("assistant://bot/" + Uri.encode(deviceId) + "/" + Uri.encode(botId)),
                open.getData());
        assertEquals(deviceId, open.getStringExtra("assistant_device_id"));
        assertEquals(botId, open.getStringExtra("assistant_bot_id"));
        assertTrue((open.getFlags() & Intent.FLAG_ACTIVITY_SINGLE_TOP) != 0);
        assertTrue((open.getFlags() & Intent.FLAG_ACTIVITY_CLEAR_TOP) != 0);
    }

    @Test
    public void blankBotNameAndNullSummaryUseDesensitizedDefaults() throws Exception {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);

        JSONObject board = boardSnapshot("bot-mail", new JSONObject()
                .put("id", "43")
                .put("kind", "proactive-google")
                .put("summary", JSONObject.NULL));

        assertTrue(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "  ", board));

        assertEquals(1, notifications.getAllNotifications().size());
        Notification notice = notifications.getAllNotifications().get(0);
        assertEquals(
                BotClientService.PROACTIVE_DEFAULT_TITLE,
                String.valueOf(notice.extras.getCharSequence(Notification.EXTRA_TITLE)));
        assertEquals(
                BotClientService.PROACTIVE_DEFAULT_SUMMARY,
                String.valueOf(notice.extras.getCharSequence(Notification.EXTRA_TEXT)));
    }

    @Test
    public void nonProactiveOrInvalidBoardResultsAreIgnored() throws Exception {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);

        // Missing kind (ordinary manual turn)
        JSONObject manualBoard = boardSnapshot("bot-mail", new JSONObject()
                .put("id", "50")
                .put("summary", "普通回复"));
        assertFalse(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "邮件助理", manualBoard));

        // Wrong kind
        JSONObject otherKindBoard = boardSnapshot("bot-mail", new JSONObject()
                .put("id", "51")
                .put("kind", "webhook")
                .put("summary", "Webhook 通知"));
        assertFalse(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "邮件助理", otherKindBoard));

        // Empty id
        JSONObject emptyIdBoard = boardSnapshot("bot-mail", new JSONObject()
                .put("id", "")
                .put("kind", "proactive-google")
                .put("summary", "有新的邮件或日程待查看"));
        assertFalse(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "邮件助理", emptyIdBoard));

        // Null lastResult
        JSONObject nullResultBoard = boardSnapshot("bot-mail", null);
        assertFalse(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "邮件助理", nullResultBoard));

        // Different botId
        JSONObject otherBotBoard = boardSnapshot("other-bot", new JSONObject()
                .put("id", "52")
                .put("kind", "proactive-google")
                .put("summary", "有新的邮件或日程待查看"));
        assertFalse(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "邮件助理", otherBotBoard));

        assertTrue(notifications.getAllNotifications().isEmpty());
    }

    @Test
    public void visibleChatSuppressesNotificationAndMarksResultIdSeen() throws Exception {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
        BotClientService.setVisibility(VISIBILITY_OWNER, "dev-1", "bot-mail", true);

        JSONObject firstBoard = boardSnapshot("bot-mail", new JSONObject()
                .put("id", "60")
                .put("kind", "proactive-google")
                .put("summary", "有新的邮件或日程待查看"));
        assertFalse(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "邮件助理", firstBoard));
        assertTrue(notifications.getAllNotifications().isEmpty());

        // Leaving chat must not retroactively notify an already-seen resultId.
        BotClientService.clearVisibility(VISIBILITY_OWNER);
        assertFalse(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "邮件助理", firstBoard));
        assertTrue(notifications.getAllNotifications().isEmpty());

        // A newer resultId after leaving chat notifies normally.
        JSONObject nextBoard = boardSnapshot("bot-mail", new JSONObject()
                .put("id", "61")
                .put("kind", "proactive-google")
                .put("summary", "有新的邮件或日程待查看"));
        assertTrue(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "邮件助理", nextBoard));
        assertEquals(1, notifications.getAllNotifications().size());
    }

    @Test
    public void duplicateResultIdIsSuppressedOnlyAfterPostingAndNewerResultIdStillNotifies() throws Exception {
        JSONObject boardA = boardSnapshot("bot-mail", new JSONObject()
                .put("id", "70")
                .put("kind", "proactive-google")
                .put("summary", "有新的邮件或日程待查看"));

        // Without POST_NOTIFICATIONS permission, does not post and does not consume dedupe key.
        assertFalse(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "邮件助理", boardA));
        assertTrue(notifications.getAllNotifications().isEmpty());

        // Once permission is granted, the same resultId posts once.
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
        assertTrue(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "邮件助理", boardA));
        assertEquals(1, notifications.getAllNotifications().size());

        // Duplicate resultId is suppressed even after the prior notification is cleared.
        app.getSystemService(NotificationManager.class).cancelAll();
        assertTrue(notifications.getAllNotifications().isEmpty());
        assertFalse(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "邮件助理", boardA));
        assertTrue(notifications.getAllNotifications().isEmpty());

        // A new resultId still notifies.
        JSONObject boardB = boardSnapshot("bot-mail", new JSONObject()
                .put("id", "71")
                .put("kind", "proactive-google")
                .put("summary", "有新的邮件或日程待查看"));
        assertTrue(BotClientService.evaluateProactiveBoardResult(app, "dev-1", "bot-mail", "邮件助理", boardB));
        assertEquals(1, notifications.getAllNotifications().size());
    }

    private static JSONObject boardSnapshot(String botId, JSONObject lastResult) throws Exception {
        JSONObject item = new JSONObject()
                .put("botId", botId)
                .put("lastResult", lastResult == null ? JSONObject.NULL : lastResult);
        return new JSONObject().put("items", new JSONArray().put(item));
    }
}
