package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.nio.charset.StandardCharsets;

/** 语音识别 partial / level（RMS 归一化 + 100ms 节流）及协议事件形状单测。 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class VoiceFeedbackTest {

    @Test
    public void normalizesRmsDbIntoUnitInterval() {
        assertEquals(0f, SpeechInput.normalizeRmsDb(-2f), 1e-6f);
        assertEquals(0.5f, SpeechInput.normalizeRmsDb(4f), 1e-6f);
        assertEquals(1f, SpeechInput.normalizeRmsDb(10f), 1e-6f);
        assertEquals(0f, SpeechInput.normalizeRmsDb(-20f), 1e-6f);
        assertEquals(1f, SpeechInput.normalizeRmsDb(30f), 1e-6f);
        assertEquals(0f, SpeechInput.normalizeRmsDb(Float.NEGATIVE_INFINITY), 1e-6f);
        assertEquals(1f, SpeechInput.normalizeRmsDb(Float.POSITIVE_INFINITY), 1e-6f);
        assertTrue(Float.isNaN(SpeechInput.normalizeRmsDb(Float.NaN)));
    }

    @Test
    public void throttlesLevelEventsToAtMostOncePer100Ms() {
        BotHostVoice.LevelThrottle throttle = new BotHostVoice.LevelThrottle();
        assertEquals(100L, BotHostVoice.LEVEL_THROTTLE_MS);

        assertEquals(Double.valueOf(0.5), throttle.accept(0.5f, 1_000L));
        assertNull(throttle.accept(0.8f, 1_000L));
        assertNull(throttle.accept(0.8f, 1_050L));
        assertNull(throttle.accept(0.8f, 1_099L));
        assertEquals(Double.valueOf(0.8), throttle.accept(0.8f, 1_100L));
        assertNull(throttle.accept(0.2f, 1_199L));
        assertEquals(Double.valueOf(0.2), throttle.accept(0.2f, 1_200L));
    }

    @Test
    public void clampsOutOfRangeAndIgnoresNaNWithoutConsumingThrottleWindow() {
        BotHostVoice.LevelThrottle throttle = new BotHostVoice.LevelThrottle();

        // NaN 不消耗节流窗口，紧随其后的有效值可立即发出。
        assertNull(throttle.accept(Float.NaN, 100L));
        assertEquals(Double.valueOf(0.0), throttle.accept(-0.5f, 100L));

        // 节流窗口内 NaN 忽略，到点后正超界钳制到 1.0。
        assertNull(throttle.accept(Float.NaN, 150L));
        assertEquals(Double.valueOf(1.0), throttle.accept(2.5f, 200L));

        // 负无穷与正无穷分别钳制到 0.0 / 1.0。
        assertEquals(Double.valueOf(0.0), throttle.accept(Float.NEGATIVE_INFINITY, 300L));
        assertEquals(Double.valueOf(1.0), throttle.accept(Float.POSITIVE_INFINITY, 400L));

        // 时钟回拨时恢复放行，不会永久锁死。
        assertEquals(Double.valueOf(0.25), throttle.accept(0.25f, 50L));
    }

    @Test
    public void buildsAndRoundTripsPartialAndLevelProtocolEvents() throws Exception {
        JSONObject partialFrame = BotHostUiProtocol.event(
                BotHostUiProtocol.EVENT_VOICE,
                BotHostUiProtocol.voicePartialEvent("bot-1", "req-1", "你好世界"));
        JSONObject parsedPartial = BotHostUiProtocol.parse(
                new String(BotHostUiProtocol.line(partialFrame), StandardCharsets.UTF_8));
        assertEquals(BotHostUiProtocol.TYPE_EVENT, parsedPartial.getString("type"));
        assertEquals(BotHostUiProtocol.EVENT_VOICE, parsedPartial.getString("event"));
        JSONObject partialData = parsedPartial.getJSONObject("data");
        assertEquals("partial", partialData.getString("type"));
        assertEquals("bot-1", partialData.getString("botId"));
        assertEquals("req-1", partialData.getString("requestId"));
        assertEquals("你好世界", partialData.getString("text"));
        assertFalse(partialData.has("value"));

        JSONObject levelFrame = BotHostUiProtocol.event(
                BotHostUiProtocol.EVENT_VOICE,
                BotHostUiProtocol.voiceLevelEvent("bot-1", "req-1", 0.625));
        JSONObject parsedLevel = BotHostUiProtocol.parse(
                new String(BotHostUiProtocol.line(levelFrame), StandardCharsets.UTF_8));
        assertEquals(BotHostUiProtocol.TYPE_EVENT, parsedLevel.getString("type"));
        assertEquals(BotHostUiProtocol.EVENT_VOICE, parsedLevel.getString("event"));
        JSONObject levelData = parsedLevel.getJSONObject("data");
        assertNotNull(levelData);
        assertEquals("level", levelData.getString("type"));
        assertEquals("bot-1", levelData.getString("botId"));
        assertEquals("req-1", levelData.getString("requestId"));
        assertEquals(0.625, levelData.getDouble("value"), 1e-6);
        assertFalse(levelData.has("text"));
    }
}
