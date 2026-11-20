package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;

import android.view.HapticFeedbackConstants;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** UI 本地触感动作（haptic）的 kind 校验与各 API 级别常量映射测试。 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class HapticFeedbackTest {

    @Test
    public void mapsAllKindsOnApi30AndAbove() {
        for (int sdk : new int[]{30, 33, 36}) {
            assertEquals(Integer.valueOf(HapticFeedbackConstants.LONG_PRESS),
                    BotHostTauriPlugin.resolveHapticConstant("longPress", sdk));
            assertEquals(Integer.valueOf(HapticFeedbackConstants.CONFIRM),
                    BotHostTauriPlugin.resolveHapticConstant("confirm", sdk));
            assertEquals(Integer.valueOf(HapticFeedbackConstants.REJECT),
                    BotHostTauriPlugin.resolveHapticConstant("reject", sdk));
            assertEquals(Integer.valueOf(HapticFeedbackConstants.CLOCK_TICK),
                    BotHostTauriPlugin.resolveHapticConstant("tick", sdk));
        }
    }

    @Test
    public void downgradesConfirmAndRejectBelowApi30() {
        for (int sdk : new int[]{26, 29}) {
            assertEquals(Integer.valueOf(HapticFeedbackConstants.LONG_PRESS),
                    BotHostTauriPlugin.resolveHapticConstant("longPress", sdk));
            assertEquals(Integer.valueOf(HapticFeedbackConstants.VIRTUAL_KEY),
                    BotHostTauriPlugin.resolveHapticConstant("confirm", sdk));
            assertEquals(Integer.valueOf(HapticFeedbackConstants.LONG_PRESS),
                    BotHostTauriPlugin.resolveHapticConstant("reject", sdk));
            assertEquals(Integer.valueOf(HapticFeedbackConstants.CLOCK_TICK),
                    BotHostTauriPlugin.resolveHapticConstant("tick", sdk));
        }
    }

    @Test
    public void rejectsUnknownOrMalformedKinds() {
        for (String invalid : new String[]{null, "", " ", "unknown", "LONG_PRESS", "Confirm", "tick ", "click"}) {
            assertNull("expected null for kind=" + invalid,
                    BotHostTauriPlugin.resolveHapticConstant(invalid, 33));
            assertNull("expected null below API 30 for kind=" + invalid,
                    BotHostTauriPlugin.resolveHapticConstant(invalid, 29));
        }
    }

    @Test
    public void validatesParamsObjectStrictly() throws Exception {
        assertEquals(Integer.valueOf(HapticFeedbackConstants.LONG_PRESS),
                BotHostTauriPlugin.resolveHapticParams(new JSONObject().put("kind", "longPress"), 33));
        assertEquals(Integer.valueOf(HapticFeedbackConstants.CONFIRM),
                BotHostTauriPlugin.resolveHapticParams(new JSONObject().put("kind", "confirm"), 33));
        assertEquals(Integer.valueOf(HapticFeedbackConstants.VIRTUAL_KEY),
                BotHostTauriPlugin.resolveHapticParams(new JSONObject().put("kind", "confirm"), 29));
        assertEquals(Integer.valueOf(HapticFeedbackConstants.REJECT),
                BotHostTauriPlugin.resolveHapticParams(new JSONObject().put("kind", "reject"), 33));
        assertEquals(Integer.valueOf(HapticFeedbackConstants.LONG_PRESS),
                BotHostTauriPlugin.resolveHapticParams(new JSONObject().put("kind", "reject"), 29));
        assertEquals(Integer.valueOf(HapticFeedbackConstants.CLOCK_TICK),
                BotHostTauriPlugin.resolveHapticParams(new JSONObject().put("kind", "tick"), 33));

        assertNull(BotHostTauriPlugin.resolveHapticParams(null, 33));
        assertNull(BotHostTauriPlugin.resolveHapticParams(new JSONObject(), 33));
        assertNull(BotHostTauriPlugin.resolveHapticParams(new JSONObject().put("other", "tick"), 33));
        assertNull(BotHostTauriPlugin.resolveHapticParams(
                new JSONObject().put("kind", "tick").put("extra", true), 33));
        assertNull(BotHostTauriPlugin.resolveHapticParams(new JSONObject().put("kind", 123), 33));
        assertNull(BotHostTauriPlugin.resolveHapticParams(new JSONObject().put("kind", true), 33));
        assertNull(BotHostTauriPlugin.resolveHapticParams(new JSONObject().put("kind", JSONObject.NULL), 33));
        assertNull(BotHostTauriPlugin.resolveHapticParams(new JSONObject().put("kind", new JSONArray()), 33));
        assertNull(BotHostTauriPlugin.resolveHapticParams(new JSONObject().put("kind", "invalid"), 33));
    }

    @Test
    public void hapticIsUiLocalNotBridgeOperation() {
        assertFalse(BotHostUiProtocol.isOperation("haptic"));
    }
}
