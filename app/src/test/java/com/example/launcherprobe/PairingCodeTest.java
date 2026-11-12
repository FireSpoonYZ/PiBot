package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** 配对码解码：线格式与 center-server/pairing.js 一致，坏输入给出可区分的错误码，且不泄露密钥。 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class PairingCodeTest {

    /** 43 个 base64url 字符（含 - 与 _），与中心签发的 24 字节随机密钥同形：32–64 位 [A-Za-z0-9_-]。 */
    private static final String SECRET = "Zq-_".repeat(10) + "x9Y";
    private static final String PEM = "-----BEGIN CERTIFICATE-----\nMIIBozCCAUmg\n-----END CERTIFICATE-----\n";

    private static String encode(String json) {
        return PairingCode.PREFIX + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(json.getBytes(StandardCharsets.UTF_8));
    }

    private static String code(JSONObject payload) {
        return encode(payload.toString());
    }

    private static JSONObject payload() throws Exception {
        return new JSONObject().put("u", "https://center.example:8443").put("c", SECRET);
    }

    private static String failureCode(String text) {
        try {
            PairingCode.parse(text);
        } catch (BridgeException failure) {
            assertEquals("not-sent", failure.outcome);
            return failure.code;
        }
        fail("expected a failure for: " + text);
        return null;
    }

    @Test public void decodesTheCenterOriginSecretAndNoCa() throws Exception {
        PairingCode parsed = PairingCode.parse(code(payload()));
        assertEquals("https://center.example:8443", parsed.url);
        assertEquals(SECRET, parsed.secret);
        assertEquals("", parsed.ca);
    }

    @Test public void carriesThePrivateCaThroughUnchanged() throws Exception {
        PairingCode parsed = PairingCode.parse(code(payload().put("a", PEM)));
        assertEquals(PEM.trim(), parsed.ca);
    }

    @Test public void ignoresWhitespaceChatAppsAndTerminalsInsert() throws Exception {
        String text = code(payload());
        String wrapped = "  " + text.substring(0, 20) + "\n" + text.substring(20, 45) + "\r\n \t" + text.substring(45) + "\n";
        assertEquals(SECRET, PairingCode.parse(wrapped).secret);
    }

    @Test public void stripsATrailingSlashFromTheOrigin() throws Exception {
        PairingCode parsed = PairingCode.parse(code(payload().put("u", "https://center.example/")));
        assertEquals("https://center.example", parsed.url);
    }

    @Test public void textThatIsNotACodeIsToldApartFromADamagedOne() {
        assertEquals("NOT_A_PAIRING_CODE", failureCode(""));
        assertEquals("NOT_A_PAIRING_CODE", failureCode("   "));
        assertEquals("NOT_A_PAIRING_CODE", failureCode("hunter2"));
        assertEquals("NOT_A_PAIRING_CODE", failureCode("https://center.example:8443"));
        assertEquals("NOT_A_PAIRING_CODE", failureCode(null));
    }

    @Test public void aCodeFromANewerCenterAsksForAnUpdate() {
        assertEquals("UNSUPPORTED_PAIRING_CODE", failureCode("pibot2.eyJ1Ijoi"));
        assertEquals("UNSUPPORTED_PAIRING_CODE", failureCode("pibot12.abc"));
    }

    @Test public void aCutOffOrGarbledCodeIsDamaged() throws Exception {
        String good = code(payload());
        assertEquals("INVALID_PAIRING_CODE", failureCode(good.substring(0, good.length() - 12)));
        assertEquals("INVALID_PAIRING_CODE", failureCode(PairingCode.PREFIX));
        assertEquals("INVALID_PAIRING_CODE", failureCode(PairingCode.PREFIX + "not base64!"));
        assertEquals("INVALID_PAIRING_CODE", failureCode(encode("not json")));
        assertEquals("INVALID_PAIRING_CODE", failureCode(encode("[]")));
    }

    @Test public void malformedUtf8IsRefusedRatherThanReplaced() {
        byte[] bytes = {'{', '"', 'u', '"', ':', (byte) 0xC3, (byte) 0x28, '}'};
        String text = PairingCode.PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        assertEquals("INVALID_PAIRING_CODE", failureCode(text));
    }

    @Test public void theSecretMustLookLikeTheCentersOneTimeSecret() throws Exception {
        assertEquals("INVALID_PAIRING_CODE", failureCode(code(payload().put("c", "short"))));
        assertEquals("INVALID_PAIRING_CODE", failureCode(code(payload().put("c", "x".repeat(65)))));
        assertEquals("INVALID_PAIRING_CODE", failureCode(code(payload().put("c", SECRET.substring(1) + "!"))));
        assertEquals("INVALID_PAIRING_CODE", failureCode(code(payload().put("c", 12345))));
        assertEquals("INVALID_PAIRING_CODE", failureCode(code(new JSONObject().put("u", "https://c.example"))));
    }

    @Test public void onlyAnHttpsOriginIsAcceptedAsTheCenter() throws Exception {
        for (String url : new String[]{"http://center.example", "https://center.example/api",
                "https://user:pw@center.example", "https://center.example?x=1", "center.example", "", "ftp://c.example"}) {
            assertEquals(url, "INVALID_PAIRING_CODE", failureCode(code(payload().put("u", url))));
        }
        assertEquals("INVALID_PAIRING_CODE", failureCode(code(payload().put("u", 7))));
    }

    @Test public void theCaMustBeACertificateAndNotTooLarge() throws Exception {
        assertEquals("INVALID_PAIRING_CODE", failureCode(code(payload().put("a", "just some text"))));
        assertEquals("INVALID_PAIRING_CODE", failureCode(code(payload().put("a", 5))));
        assertEquals("INVALID_PAIRING_CODE", failureCode(code(payload().put("a", PEM + "A".repeat(64 * 1024)))));
        // JSON null counts as no CA.
        assertEquals("", PairingCode.parse(code(payload().put("a", JSONObject.NULL))).ca);
    }

    @Test public void anAbsurdlyLongInputIsRefusedBeforeDecoding() {
        assertEquals("INVALID_PAIRING_CODE", failureCode(PairingCode.PREFIX + "A".repeat(96 * 1024 + 1)));
    }

    @Test public void descriptionNeverContainsTheSecret() throws Exception {
        PairingCode parsed = PairingCode.parse(code(payload().put("a", PEM)));
        String text = parsed.toString();
        assertNotNull(text);
        assertFalse(text.contains(SECRET));
        assertTrue(text.contains("center.example"));
    }
}
