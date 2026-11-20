package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;

/** Android Bot 浏览器策略、外部授权白名单与隔离会话管理器回归测试。 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class BotBrowserPolicyTest {

    @Test
    public void profileNamesAreIsolatedPerBotAndNeverDefault() {
        String p1 = BotBrowserPolicy.profileNameForOwner("dev-1", "bot-a");
        String p2 = BotBrowserPolicy.profileNameForOwner("dev-1", "bot-b");
        String p3 = BotBrowserPolicy.profileNameForOwner("dev-2", "bot-a");

        assertTrue(p1.startsWith("bot-"));
        assertNotEquals(BotBrowserPolicy.DEFAULT_PROFILE_NAME, p1);
        assertEquals(p1, BotBrowserPolicy.profileNameForOwner("dev-1", "bot-a"));
        assertNotEquals(p1, p2);
        assertNotEquals(p1, p3);
    }

    @Test
    public void navigationPolicyBlocksUnsafeSchemesAndGoogleOAuth() throws Exception {
        for (String bad : new String[]{
                "file:///etc/passwd",
                "javascript:alert(1)",
                "content://com.example/secret",
                "intent://scan/#Intent;end",
                "data:text/html,<script>alert(1)</script>",
                "https://user:pass@example.com/path"
        }) {
            BotBrowserBridge.Failure failure = assertThrows(
                    BotBrowserBridge.Failure.class,
                    () -> BotBrowserPolicy.validateNavigationUrl(bad));
            assertEquals("BROWSER_NAVIGATION_BLOCKED", failure.code);
        }

        BotBrowserPolicy.UrlCheck oauth = BotBrowserPolicy.validateNavigationUrl(
                "https://accounts.google.com/o/oauth2/v2/auth?client_id=123");
        assertEquals(BotBrowserPolicy.Sensitivity.BLOCKED_EXTERNAL_AUTH, oauth.sensitivity);
        assertTrue(oauth.sensitivity.blocksWebViewNavigation());

        BotBrowserPolicy.UrlCheck callback = BotBrowserPolicy.validateNavigationUrl(
                "https://center.example.com/api/oauth/google/callback?code=abc&state=xyz");
        assertEquals(BotBrowserPolicy.Sensitivity.BLOCKED_EXTERNAL_AUTH, callback.sensitivity);
        assertTrue(callback.sensitivity.blocksWebViewNavigation());

        BotBrowserPolicy.UrlCheck myAccount = BotBrowserPolicy.validateNavigationUrl(
                "https://myaccount.google.com/connections");
        assertEquals(BotBrowserPolicy.Sensitivity.SECRET_SHIELD, myAccount.sensitivity);
        assertTrue(myAccount.sensitivity.blocksAgentObservation());

        BotBrowserPolicy.UrlCheck normalConsole = BotBrowserPolicy.validateNavigationUrl(
                "https://console.cloud.google.com/apis/enableflow?apiid=gmail.googleapis.com");
        assertEquals(BotBrowserPolicy.Sensitivity.NORMAL, normalConsole.sensitivity);
    }

    @Test
    public void sensitiveAgentControlsBlockPolicyAndOAuthCreate() {
        assertTrue(BotBrowserPolicy.isSensitiveAgentControl(
                "https://console.cloud.google.com/auth/overview/create",
                "input", "checkbox", "", "I agree to the Google API Services: User Data Policy"));
        assertTrue(BotBrowserPolicy.isSensitiveAgentControl(
                "https://console.cloud.google.com/apis/credentials/oauthclient",
                "button", "", "", "Create"));
        assertTrue(BotBrowserPolicy.isSensitiveAgentControl(
                "https://example.com/login",
                "input", "password", "current-password", "Password"));
        assertTrue(BotBrowserPolicy.isSensitiveAgentControl(
                "https://console.cloud.google.com/apis/credentials",
                "button", "", "", "Download JSON"));
        assertFalse(BotBrowserPolicy.isSensitiveAgentControl(
                "https://console.cloud.google.com/auth/overview/create",
                "input", "text", "", "App name"));
    }

    @Test
    public void trustedExternalOpenerAllowsOnlyGoogleAuthAndConfiguredCenterOrigin() {
        String googleAuth = TrustedExternalOpener.validateUrl(
                "https://accounts.google.com/o/oauth2/v2/auth?scope=openid", null);
        assertTrue(googleAuth.startsWith("https://accounts.google.com/"));

        String consoleUrl = TrustedExternalOpener.validateUrl(
                "https://console.cloud.google.com/apis/credentials", null);
        assertTrue(consoleUrl.startsWith("https://console.cloud.google.com/"));

        String centerPage = TrustedExternalOpener.validateUrl(
                "https://center.internal.example:8443/google/manage",
                "https://center.internal.example:8443");
        assertEquals("https://center.internal.example:8443/google/manage", centerPage);

        assertThrows(IllegalArgumentException.class, () ->
                TrustedExternalOpener.validateUrl("http://accounts.google.com/o/oauth2/v2/auth", null));
        assertThrows(IllegalArgumentException.class, () ->
                TrustedExternalOpener.validateUrl("https://accounts.google.com:8443/o/oauth2/v2/auth", null));
        assertThrows(IllegalArgumentException.class, () ->
                TrustedExternalOpener.validateUrl("https://accounts.google.com.evil.example/", null));
        assertThrows(IllegalArgumentException.class, () ->
                TrustedExternalOpener.validateUrl("https://evil.example/phish", "https://center.internal.example:8443"));
        assertThrows(IllegalArgumentException.class, () ->
                TrustedExternalOpener.validateUrl("https://center.internal.example:9443/google", "https://center.internal.example:8443"));
    }

    @Test
    public void unsupportedMultiProfileReportsUnavailableAndNeverCreatesWebView() throws Exception {
        AtomicInteger createCalls = new AtomicInteger();
        FakeBackend backend = new FakeBackend(BotBrowserManager.Availability.unsupported(
                "MULTI_PROFILE unsupported"), createCalls);
        BotBrowserManager manager = new BotBrowserManager(backend, () -> 1_000L);

        JSONObject status = manager.status("dev-1", "bot-1", "agent", () -> false);
        assertFalse(status.getBoolean("available"));
        assertFalse(status.getBoolean("canStreamInteract"));
        assertEquals("guide-browser", status.getString("fallbackMode"));
        assertTrue(status.getBoolean("externalBrowserRecommendedForSetup"));
        assertEquals(0, createCalls.get());

        BotBrowserBridge.Failure openFail = assertThrows(BotBrowserBridge.Failure.class, () ->
                manager.open("dev-1", "bot-1", "agent",
                        new JSONObject().put("url", "https://example.com"), () -> false));
        assertEquals("BROWSER_PROFILE_UNSUPPORTED", openFail.code);
        assertEquals(0, createCalls.get());
    }

    @Test
    public void perBotIsolationRevisionCheckAndHumanTakeoverInputWorkEndToEnd() throws Exception {
        AtomicInteger createCalls = new AtomicInteger();
        AtomicLong now = new AtomicLong(10_000L);
        FakeBackend backend = new FakeBackend(BotBrowserManager.Availability.supported(), createCalls);
        BotBrowserManager manager = new BotBrowserManager(backend, now::get);
        BotBrowserBridge bridge = new BotBrowserBridge(manager);

        JSONObject ctxBotA = new JSONObject().put("deviceId", "dev-1").put("botId", "bot-a");
        JSONObject ctxBotB = new JSONObject().put("deviceId", "dev-1").put("botId", "bot-b");

        JSONObject openedA = bridge.execute(ctxBotA, new JSONObject()
                .put("action", "open")
                .put("source", "agent")
                .put("url", "https://console.cloud.google.com/auth/overview/create"), () -> false);
        assertTrue(openedA.getBoolean("available"));
        assertTrue(openedA.getBoolean("canStreamInteract"));
        String pageA = openedA.getString("pageId");
        long revA = openedA.getLong("revision");

        // Bot B 无法访问 Bot A 的标签页。
        BotBrowserBridge.Failure crossBot = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctxBotB, new JSONObject()
                        .put("action", "select")
                        .put("source", "human")
                        .put("pageId", pageA), () -> false));
        assertEquals("BROWSER_PAGE_NOT_FOUND", crossBot.code);

        // Agent 禁止直接调用原始 input。
        BotBrowserBridge.Failure agentInput = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctxBotA, new JSONObject()
                        .put("action", "input")
                        .put("source", "agent")
                        .put("pageId", pageA)
                        .put("revision", revA)
                        .put("event", new JSONObject().put("kind", "click").put("x", 0.5).put("y", 0.5)), () -> false));
        assertEquals("INVALID_ARGUMENT", agentInput.code);

        // 过期 revision 的人类输入被拒绝且不会派发到底层 WebView。
        BotBrowserBridge.Failure staleInput = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctxBotA, new JSONObject()
                        .put("action", "input")
                        .put("source", "human")
                        .put("pageId", pageA)
                        .put("revision", revA + 99)
                        .put("event", new JSONObject().put("kind", "click").put("x", 0.5).put("y", 0.5)), () -> false));
        assertEquals("BROWSER_REVISION_MISMATCH", staleInput.code);
        assertEquals(0, backend.dispatchedInputs.size());

        // 匹配 revision 的人类接管输入成功派发到同一页并推进 revision。
        JSONObject applied = bridge.execute(ctxBotA, new JSONObject()
                .put("action", "input")
                .put("source", "human")
                .put("pageId", pageA)
                .put("revision", revA)
                .put("event", new JSONObject().put("kind", "click").put("x", 0.4).put("y", 0.6)), () -> false);
        assertTrue(applied.getBoolean("ok"));
        assertEquals(revA + 1, applied.getLong("revision"));
        assertEquals(1, backend.dispatchedInputs.size());

        // Bot 尝试在政策勾选框上执行 act 时被硬阻断，无法自动勾选。
        backend.nextSnapshot = new JSONObject()
                .put("sensitiveBlocked", false)
                .put("hasPolicyConsent", true)
                .put("interactive", new JSONArray().put(new JSONObject()
                        .put("ref", "e1")
                        .put("tag", "input")
                        .put("type", "checkbox")
                        .put("text", "I agree to the Google API Services: User Data Policy")))
                .put("textSummary", "Google API Services: User Data Policy");
        JSONObject snap = bridge.execute(ctxBotA, new JSONObject()
                .put("action", "snapshot")
                .put("source", "agent")
                .put("pageId", pageA), () -> false);
        assertTrue(snap.getBoolean("requiresHumanTakeover"));

        BotBrowserBridge.Failure policyBlock = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctxBotA, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", pageA)
                        .put("act", new JSONObject().put("kind", "check").put("ref", "e1")), () -> false));
        assertEquals("BROWSER_SENSITIVE_BLOCKED", policyBlock.code);

        // release 与 shutdown 销毁标签页。
        bridge.shutdown();
        assertEquals(1, backend.destroyedTabs.get());
    }

    private static final class FakeHandle implements BotBrowserManager.TabHandle {
        final String profileName;
        FakeHandle(String profileName) { this.profileName = profileName; }
        @Override public int viewportWidth() { return 960; }
        @Override public int viewportHeight() { return 640; }
        @Override public boolean canGoBack() { return false; }
        @Override public boolean canGoForward() { return false; }
    }

    private static final class FakeBackend implements BotBrowserManager.Backend {
        final BotBrowserManager.Availability availability;
        final AtomicInteger createCalls;
        final AtomicInteger destroyedTabs = new AtomicInteger();
        final List<JSONObject> dispatchedInputs = new ArrayList<>();
        JSONObject nextSnapshot = new JSONObject();

        FakeBackend(BotBrowserManager.Availability availability, AtomicInteger createCalls) {
            this.availability = availability;
            this.createCalls = createCalls;
        }

        @Override
        public BotBrowserManager.Availability probeAvailability(BooleanSupplier cancelled) {
            return availability;
        }

        @Override
        public BotBrowserManager.TabHandle createTab(String profileName, int width, int height,
                BotBrowserManager.TabCallbacks callbacks, BooleanSupplier cancelled) {
            createCalls.incrementAndGet();
            assertNotEquals(BotBrowserPolicy.DEFAULT_PROFILE_NAME, profileName);
            return new FakeHandle(profileName);
        }

        @Override public void loadUrl(BotBrowserManager.TabHandle tab, String url, BooleanSupplier cancelled) { }
        @Override public boolean goBack(BotBrowserManager.TabHandle tab, BooleanSupplier cancelled) { return false; }
        @Override public boolean goForward(BotBrowserManager.TabHandle tab, BooleanSupplier cancelled) { return false; }
        @Override public void reload(BotBrowserManager.TabHandle tab, BooleanSupplier cancelled) { }

        @Override
        public BotBrowserManager.FrameCapture captureFrame(BotBrowserManager.TabHandle tab, int maxWidth,
                int maxHeight, int maxBytes, String preferredMimeType, BooleanSupplier cancelled) {
            return new BotBrowserManager.FrameCapture("image/jpeg", "AAAA", 960, 640, 960, 640);
        }

        @Override
        public JSONObject snapshotDom(BotBrowserManager.TabHandle tab, String snapshotToken, String source,
                BooleanSupplier cancelled) {
            return nextSnapshot;
        }

        @Override
        public JSONObject actDom(BotBrowserManager.TabHandle tab, String snapshotToken, String source,
                String currentUrl, JSONObject act, BooleanSupplier cancelled) {
            return new JSONObject();
        }

        @Override
        public void dispatchHumanInput(BotBrowserManager.TabHandle tab, JSONObject event,
                BooleanSupplier cancelled) {
            dispatchedInputs.add(event);
        }

        @Override
        public void destroyTab(BotBrowserManager.TabHandle tab) {
            destroyedTabs.incrementAndGet();
        }
    }
}
