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
import java.util.concurrent.atomic.AtomicBoolean;
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

    @Test
    public void waitEnforcesMultiConditionAndLoadStatesAndRejectsNetworkidleOrEval() throws Exception {
        AtomicInteger createCalls = new AtomicInteger();
        AtomicLong now = new AtomicLong(10_000L);
        FakeBackend backend = new FakeBackend(BotBrowserManager.Availability.supported(), createCalls);
        BotBrowserManager manager = new BotBrowserManager(backend, now::get);
        BotBrowserBridge bridge = new BotBrowserBridge(manager);
        JSONObject ctx = new JSONObject().put("deviceId", "dev-1").put("botId", "bot-wait");

        JSONObject opened = bridge.execute(ctx, new JSONObject()
                .put("action", "open")
                .put("source", "agent")
                .put("url", "https://example.com/start"), () -> false);
        String pageId = opened.getString("pageId");

        // networkidle 无法在 Android WebView 上可靠支持 -> 明确返回 BROWSER_UNSUPPORTED，绝不假成功。
        BotBrowserBridge.Failure networkIdle = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctx, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", pageId)
                        .put("act", new JSONObject().put("kind", "wait").put("load", "networkidle").put("timeoutMs", 500)),
                        () -> false));
        assertEquals("BROWSER_UNSUPPORTED", networkIdle.code);
        assertEquals(0, backend.waitProbeConditions.size());

        // 禁止 eval/fn 任意表达式与无 selector 的孤立 state。
        BotBrowserBridge.Failure evalReject = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctx, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", pageId)
                        .put("act", new JSONObject().put("kind", "wait").put("fn", "() => true")),
                        () -> false));
        assertEquals("INVALID_ARGUMENT", evalReject.code);

        BotBrowserBridge.Failure orphanState = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctx, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", pageId)
                        .put("act", new JSONObject().put("kind", "wait").put("state", "hidden")),
                        () -> false));
        assertEquals("INVALID_ARGUMENT", orphanState.code);

        // 多条件 AND：selector + state + text + exact url + load 必须同时满足。
        backend.waitProbeHandler = (conditions, attempt) -> {
            now.addAndGet(10L);
            if (attempt == 1) {
                return new JSONObject()
                        .put("selectorMatched", true)
                        .put("textMatched", false)
                        .put("currentUrl", "https://example.com/done")
                        .put("readyState", "complete");
            }
            if (attempt == 2) {
                // URL 多出 query，不是精确匹配，不能放行。
                return new JSONObject()
                        .put("selectorMatched", true)
                        .put("textMatched", true)
                        .put("currentUrl", "https://example.com/done?extra=1")
                        .put("readyState", "complete");
            }
            if (attempt == 3) {
                // readyState 为 interactive 且仍在 loading，load='load' 不能放行。
                return new JSONObject()
                        .put("selectorMatched", true)
                        .put("textMatched", true)
                        .put("currentUrl", "https://example.com/done")
                        .put("readyState", "interactive");
            }
            backend.lastCallbacks.onPageFinished("https://example.com/done");
            return new JSONObject()
                    .put("selectorMatched", true)
                    .put("textMatched", true)
                    .put("currentUrl", "https://example.com/done")
                    .put("readyState", "complete");
        };

        JSONObject waited = bridge.execute(ctx, new JSONObject()
                .put("action", "act")
                .put("source", "agent")
                .put("pageId", pageId)
                .put("act", new JSONObject()
                        .put("kind", "wait")
                        .put("selector", "#ready")
                        .put("state", "visible")
                        .put("text", "Saved")
                        .put("url", "https://example.com/done")
                        .put("load", "load")
                        .put("timeoutMs", 2000)), () -> false);
        assertTrue(waited.getBoolean("ok"));
        assertEquals(4, backend.waitProbeConditions.size());
        JSONObject sentCond = backend.waitProbeConditions.get(0);
        assertEquals("#ready", sentCond.getString("selector"));
        assertEquals("visible", sentCond.getString("state"));
        assertEquals("Saved", sentCond.getString("text"));
        assertEquals("https://example.com/done", sentCond.getString("url"));
        assertEquals("load", sentCond.getString("load"));

        // navigate 后 tab.loading=true：domcontentloaded 忽略旧页残留 complete，直到 interactive 才放行。
        bridge.execute(ctx, new JSONObject()
                .put("action", "navigate")
                .put("source", "agent")
                .put("pageId", pageId)
                .put("url", "https://example.com/next"), () -> false);
        backend.waitProbeConditions.clear();
        backend.waitProbeHandler = (conditions, attempt) -> {
            now.addAndGet(10L);
            if (attempt == 1) {
                return new JSONObject().put("readyState", "complete");
            }
            return new JSONObject().put("readyState", "interactive");
        };
        JSONObject dclWait = bridge.execute(ctx, new JSONObject()
                .put("action", "act")
                .put("source", "agent")
                .put("pageId", pageId)
                .put("act", new JSONObject()
                        .put("kind", "wait")
                        .put("load", "domcontentloaded")
                        .put("timeoutMs", 1000)), () -> false);
        assertTrue(dclWait.getBoolean("ok"));
        assertEquals(2, backend.waitProbeConditions.size());

        // selector hidden + 非法 CSS 选择器不得假算隐藏。
        backend.waitProbeConditions.clear();
        backend.waitProbeHandler = (conditions, attempt) -> new JSONObject()
                .put("invalidSelector", true)
                .put("selectorMatched", false);
        BotBrowserBridge.Failure badSelector = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctx, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", pageId)
                        .put("act", new JSONObject()
                                .put("kind", "wait")
                                .put("selector", "[[[bad")
                                .put("state", "hidden")
                                .put("timeoutMs", 500)), () -> false));
        assertEquals("INVALID_ARGUMENT", badSelector.code);
        assertEquals("hidden", backend.waitProbeConditions.get(0).getString("state"));

        bridge.shutdown();
    }

    @Test
    public void waitHandlesTimeoutCancellationMidWaitSensitivityAndDelayOnlyCompat() throws Exception {
        AtomicInteger createCalls = new AtomicInteger();
        AtomicLong now = new AtomicLong(20_000L);
        FakeBackend backend = new FakeBackend(BotBrowserManager.Availability.supported(), createCalls);
        BotBrowserManager manager = new BotBrowserManager(backend, now::get);
        BotBrowserBridge bridge = new BotBrowserBridge(manager);
        JSONObject ctx = new JSONObject().put("deviceId", "dev-1").put("botId", "bot-wait-edge");

        JSONObject opened = bridge.execute(ctx, new JSONObject()
                .put("action", "open")
                .put("source", "agent")
                .put("url", "https://example.com/form"), () -> false);
        String pageId = opened.getString("pageId");
        backend.lastCallbacks.onPageFinished("https://example.com/form");

        // 条件一直未满足 -> 超时失败（绝不 sleep 后假成功）。
        backend.waitProbeConditions.clear();
        backend.waitProbeHandler = (conditions, attempt) -> {
            now.addAndGet(100L);
            return new JSONObject().put("selectorMatched", false);
        };
        BotBrowserBridge.Failure timedOut = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctx, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", pageId)
                        .put("act", new JSONObject()
                                .put("kind", "wait")
                                .put("selector", "#never-appears")
                                .put("timeoutMs", 200)), () -> false));
        assertEquals("BROWSER_TIMEOUT", timedOut.code);
        assertTrue(backend.waitProbeConditions.size() >= 2);

        // 等待过程中被取消 -> 返回 CANCELLED。
        backend.waitProbeConditions.clear();
        AtomicBoolean cancelled = new AtomicBoolean(false);
        backend.waitProbeHandler = (conditions, attempt) -> {
            if (attempt >= 1) cancelled.set(true);
            return new JSONObject().put("textMatched", false);
        };
        BotBrowserBridge.Failure cancelFail = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctx, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", pageId)
                        .put("act", new JSONObject()
                                .put("kind", "wait")
                                .put("text", "Never")
                                .put("timeoutMs", 2000)), cancelled::get));
        assertEquals("CANCELLED", cancelFail.code);

        // 只延时兼容（正常页 ms=0 与 timeoutMs=50）。
        backend.waitProbeConditions.clear();
        backend.waitProbeHandler = (conditions, attempt) -> {
            now.addAndGet(60L);
            return new JSONObject().put("sensitiveBlocked", false);
        };
        JSONObject delayZero = bridge.execute(ctx, new JSONObject()
                .put("action", "act")
                .put("source", "agent")
                .put("pageId", pageId)
                .put("act", new JSONObject().put("kind", "wait").put("ms", 0)), () -> false);
        assertTrue(delayZero.getBoolean("ok"));

        JSONObject delayCompat = bridge.execute(ctx, new JSONObject()
                .put("action", "act")
                .put("source", "agent")
                .put("pageId", pageId)
                .put("act", new JSONObject().put("kind", "wait").put("timeoutMs", 50)), () -> false);
        assertTrue(delayCompat.getBoolean("ok"));

        // 等待中进入敏感态（DOM 出现密码框）-> 立即中断返回 BROWSER_SENSITIVE_BLOCKED。
        backend.waitProbeConditions.clear();
        backend.waitProbeHandler = (conditions, attempt) -> {
            if (attempt == 1) {
                return new JSONObject().put("selectorMatched", false);
            }
            return new JSONObject()
                    .put("sensitiveBlocked", true)
                    .put("hasPasswordField", true);
        };
        BotBrowserBridge.Failure midWaitSensitive = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctx, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", pageId)
                        .put("act", new JSONObject()
                                .put("kind", "wait")
                                .put("selector", "#done")
                                .put("timeoutMs", 2000)), () -> false));
        assertEquals("BROWSER_SENSITIVE_BLOCKED", midWaitSensitive.code);
        assertEquals(2, backend.waitProbeConditions.size());

        // 只延时等待期间触发受阻外部 OAuth 跳转同样阻断。
        backend.waitProbeConditions.clear();
        JSONObject opened2 = bridge.execute(ctx, new JSONObject()
                .put("action", "open")
                .put("source", "agent")
                .put("url", "https://example.com/step2"), () -> false);
        String page2 = opened2.getString("pageId");
        backend.waitProbeHandler = (conditions, attempt) -> {
            backend.lastCallbacks.onBlockedExternalNavigation("google_auth_requires_system_browser");
            return new JSONObject().put("sensitiveBlocked", false);
        };
        BotBrowserBridge.Failure blockedRedirect = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctx, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", page2)
                        .put("act", new JSONObject().put("kind", "wait").put("ms", 200)), () -> false));
        assertEquals("BROWSER_SENSITIVE_BLOCKED", blockedRedirect.code);

        bridge.shutdown();
    }

    @Test
    public void refLessTypeTargetsFocusedEditableWithoutHumanInputAndKeepsSensitivityGuards() throws Exception {
        AtomicInteger createCalls = new AtomicInteger();
        AtomicLong now = new AtomicLong(30_000L);
        FakeBackend backend = new FakeBackend(BotBrowserManager.Availability.supported(), createCalls);
        BotBrowserManager manager = new BotBrowserManager(backend, now::get);
        BotBrowserBridge bridge = new BotBrowserBridge(manager);
        JSONObject ctx = new JSONObject().put("deviceId", "dev-1").put("botId", "bot-type");

        JSONObject opened = bridge.execute(ctx, new JSONObject()
                .put("action", "open")
                .put("source", "agent")
                .put("url", "https://console.cloud.google.com/auth/overview/create"), () -> false);
        String pageId = opened.getString("pageId");

        // 公共 type 仅提供 text（无 ref、无需先 snapshot），走 agent actDom，绝不借用人类 input 通道。
        backend.nextActResult = new JSONObject().put("ok", true);
        JSONObject typed = bridge.execute(ctx, new JSONObject()
                .put("action", "act")
                .put("source", "agent")
                .put("pageId", pageId)
                .put("act", new JSONObject().put("kind", "type").put("text", "PiBot-App")), () -> false);
        assertTrue(typed.getBoolean("ok"));
        assertEquals(0, backend.dispatchedInputs.size());
        assertEquals(1, backend.actDomCalls.size());
        assertEquals("agent", backend.actDomSources.get(0));
        assertEquals("type", backend.actDomCalls.get(0).getString("kind"));
        assertEquals("PiBot-App", backend.actDomCalls.get(0).getString("text"));
        assertFalse(backend.actDomCalls.get(0).has("ref"));

        // 空文本被拒。
        BotBrowserBridge.Failure emptyType = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctx, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", pageId)
                        .put("act", new JSONObject().put("kind", "type").put("text", "")), () -> false));
        assertEquals("INVALID_ARGUMENT", emptyType.code);

        // 非编辑聚焦目标被拒，不借人类输入。
        backend.nextActResult = new JSONObject()
                .put("ok", false)
                .put("code", "BROWSER_BACKEND_FAILED")
                .put("message", "当前没有聚焦的可编辑控件，无法执行 type");
        BotBrowserBridge.Failure nonEditable = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctx, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", pageId)
                        .put("act", new JSONObject().put("kind", "type").put("text", "hello")), () -> false));
        assertEquals("BROWSER_BACKEND_FAILED", nonEditable.code);
        assertEquals(0, backend.dispatchedInputs.size());

        // 聚焦敏感密码框时被元素级检查硬阻断并升级 SECRET_SHIELD，且绝不落入人类输入。
        backend.nextActResult = new JSONObject()
                .put("ok", false)
                .put("code", "BROWSER_SENSITIVE_BLOCKED")
                .put("secretShield", true)
                .put("sensitiveReason", "password_input_detected")
                .put("message", "命中条款/凭据敏感控件，Bot 已停手等待人类接管");
        BotBrowserBridge.Failure sensitiveType = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctx, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", pageId)
                        .put("act", new JSONObject().put("kind", "type").put("text", "secret")), () -> false));
        assertEquals("BROWSER_SENSITIVE_BLOCKED", sensitiveType.code);
        assertEquals(0, backend.dispatchedInputs.size());

        // 升级 SECRET_SHIELD 后，后续 agent act 直接在进入 DOM 前被阻断。
        int actCountBefore = backend.actDomCalls.size();
        BotBrowserBridge.Failure blockedAfterShield = assertThrows(BotBrowserBridge.Failure.class, () ->
                bridge.execute(ctx, new JSONObject()
                        .put("action", "act")
                        .put("source", "agent")
                        .put("pageId", pageId)
                        .put("act", new JSONObject().put("kind", "type").put("text", "again")), () -> false));
        assertEquals("BROWSER_SENSITIVE_BLOCKED", blockedAfterShield.code);
        assertEquals(actCountBefore, backend.actDomCalls.size());

        // 固定脚本契约检查：只读 wait 探测无 eval、转义安全、支持不存在算隐藏/子串/精确 URL；
        // 无 ref type 脚本聚焦 activeElement、执行敏感与可编辑校验并按光标/选区插入。
        String waitScript = BotBrowserManager.buildWaitProbeScript("agent", new JSONObject()
                .put("selector", "div[data-x=\"a\"]")
                .put("state", "hidden")
                .put("text", "Hello</script>")
                .put("url", "https://example.com/exact"));
        assertFalse(waitScript.contains("eval("));
        assertFalse(waitScript.contains("new Function"));
        assertTrue(waitScript.contains("state === 'hidden') ? !anyVisible : anyVisible"));
        assertTrue(waitScript.contains("bodyText.includes(targetText)"));
        assertTrue(waitScript.contains("currentUrl === targetUrl"));
        assertTrue(waitScript.contains("sensitiveBlocked: true"));
        assertTrue(waitScript.contains("\\u003c/script\\u003e"));

        String typeScript = BotBrowserManager.buildActScript(null, "agent",
                "https://console.cloud.google.com/auth/overview/create",
                new JSONObject().put("kind", "type").put("text", "PiBot"));
        assertFalse(typeScript.contains("eval("));
        assertFalse(typeScript.contains("new Function"));
        assertTrue(typeScript.contains("document.activeElement"));
        assertTrue(typeScript.contains("hasSecretDialog"));
        assertTrue(typeScript.contains("checkSensitiveNode"));
        assertTrue(typeScript.contains("isEditableControl"));
        assertTrue(typeScript.contains("selectionStart"));
        assertTrue(typeScript.contains("setSelectionRange"));
        assertTrue(typeScript.contains("range.deleteContents()"));

        bridge.shutdown();
    }

    private interface WaitProbeHandler {
        JSONObject probe(JSONObject conditions, int attempt) throws Exception;
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
        final List<JSONObject> actDomCalls = new ArrayList<>();
        final List<String> actDomSources = new ArrayList<>();
        final List<JSONObject> waitProbeConditions = new ArrayList<>();
        BotBrowserManager.TabCallbacks lastCallbacks;
        JSONObject nextSnapshot = new JSONObject();
        JSONObject nextActResult = new JSONObject();
        WaitProbeHandler waitProbeHandler;

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
            lastCallbacks = callbacks;
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
            actDomCalls.add(act);
            actDomSources.add(source);
            return nextActResult;
        }

        @Override
        public JSONObject probeWaitCondition(BotBrowserManager.TabHandle tab, String source,
                JSONObject conditions, BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
            waitProbeConditions.add(conditions);
            if (waitProbeHandler == null) {
                return new JSONObject();
            }
            try {
                return waitProbeHandler.probe(conditions, waitProbeConditions.size());
            } catch (BotBrowserBridge.Failure failure) {
                throw failure;
            } catch (Exception other) {
                throw new BotBrowserBridge.Failure("BROWSER_BACKEND_FAILED", other.getMessage());
            }
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
