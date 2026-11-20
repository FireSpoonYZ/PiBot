package com.example.launcherprobe;

import android.view.KeyEvent;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Android Bot 内置浏览器的纯策略与输入校验层（无 Android UI 依赖，便于单测）。
 *
 * 守住四条安全红线：
 * 1. 每 Bot 独立 WebView Profile 名称（永不退回 Default profile 或共享 App UI WebView）；
 * 2. 仅允许受控 http/https/about:blank 导航，硬拦截 Google OAuth / 回调 / file / intent / javascript；
 * 3. 敏感凭据/密码/OTP/Client Secret 弹窗硬阻断 Bot 观察、DOM 读取与截图；
 * 4. 条款/政策勾选与 OAuth Client Create/Secret 控件禁止 Bot 自动点击。
 */
final class BotBrowserPolicy {
    static final int MAX_URL_LENGTH = 4096;
    static final int MAX_TEXT_LENGTH = 2048;
    static final int MAX_TABS_PER_BOT = 6;
    static final int MAX_BOT_SESSIONS = 4;
    static final int DEFAULT_VIEWPORT_WIDTH = 960;
    static final int DEFAULT_VIEWPORT_HEIGHT = 640;
    static final int MIN_VIEWPORT_DIM = 320;
    static final int MAX_FRAME_WIDTH = 1280;
    static final int MAX_FRAME_HEIGHT = 800;
    static final int MAX_FRAME_BASE64_BYTES = 512 * 1024;
    static final int MAX_WHEEL_DELTA = 2000;
    static final int MAX_WAIT_MS = 5000;
    static final String PROFILE_PREFIX = "bot-";
    static final String DEFAULT_PROFILE_NAME = "Default";

    private static final Set<String> ALLOWED_SCHEMES = Set.of("http", "https");
    private static final Set<String> ACT_KINDS = Set.of(
            "click", "fill", "type", "select", "check", "uncheck", "press", "scroll", "wait");
    private static final Set<String> INPUT_KINDS = Set.of("click", "text", "key", "wheel");
    private static final Pattern REF_PATTERN = Pattern.compile("^e[1-9][0-9]{0,2}$");

    private static final Map<String, Integer> KEY_CODES;
    static {
        Map<String, Integer> keys = new LinkedHashMap<>();
        keys.put("ENTER", KeyEvent.KEYCODE_ENTER);
        keys.put("RETURN", KeyEvent.KEYCODE_ENTER);
        keys.put("TAB", KeyEvent.KEYCODE_TAB);
        keys.put("ESCAPE", KeyEvent.KEYCODE_ESCAPE);
        keys.put("ESC", KeyEvent.KEYCODE_ESCAPE);
        keys.put("SPACE", KeyEvent.KEYCODE_SPACE);
        keys.put(" ", KeyEvent.KEYCODE_SPACE);
        keys.put("BACKSPACE", KeyEvent.KEYCODE_DEL);
        keys.put("DELETE", KeyEvent.KEYCODE_FORWARD_DEL);
        keys.put("ARROWLEFT", KeyEvent.KEYCODE_DPAD_LEFT);
        keys.put("LEFT", KeyEvent.KEYCODE_DPAD_LEFT);
        keys.put("ARROWRIGHT", KeyEvent.KEYCODE_DPAD_RIGHT);
        keys.put("RIGHT", KeyEvent.KEYCODE_DPAD_RIGHT);
        keys.put("ARROWUP", KeyEvent.KEYCODE_DPAD_UP);
        keys.put("UP", KeyEvent.KEYCODE_DPAD_UP);
        keys.put("ARROWDOWN", KeyEvent.KEYCODE_DPAD_DOWN);
        keys.put("DOWN", KeyEvent.KEYCODE_DPAD_DOWN);
        keys.put("HOME", KeyEvent.KEYCODE_MOVE_HOME);
        keys.put("END", KeyEvent.KEYCODE_MOVE_END);
        keys.put("PAGEUP", KeyEvent.KEYCODE_PAGE_UP);
        keys.put("PAGEDOWN", KeyEvent.KEYCODE_PAGE_DOWN);
        for (char c = 'A'; c <= 'Z'; c++) {
            keys.put(String.valueOf(c), KeyEvent.KEYCODE_A + (c - 'A'));
        }
        for (char c = '0'; c <= '9'; c++) {
            keys.put(String.valueOf(c), KeyEvent.KEYCODE_0 + (c - '0'));
        }
        KEY_CODES = Collections.unmodifiableMap(keys);
    }

    enum Sensitivity {
        NORMAL,
        POLICY_CONSENT,
        SECRET_SHIELD,
        BLOCKED_EXTERNAL_AUTH;

        boolean isSensitive() {
            return this != NORMAL;
        }

        boolean blocksAgentObservation() {
            return this == SECRET_SHIELD || this == BLOCKED_EXTERNAL_AUTH;
        }

        boolean blocksWebViewNavigation() {
            return this == BLOCKED_EXTERNAL_AUTH;
        }

        boolean blocksHumanFrame() {
            return this == SECRET_SHIELD || this == BLOCKED_EXTERNAL_AUTH;
        }

        boolean requiresSystemBrowser() {
            return this == SECRET_SHIELD || this == BLOCKED_EXTERNAL_AUTH;
        }
    }

    static final class UrlCheck {
        final String canonicalUrl;
        final Sensitivity sensitivity;
        final String reason;

        UrlCheck(String canonicalUrl, Sensitivity sensitivity, String reason) {
            this.canonicalUrl = canonicalUrl;
            this.sensitivity = sensitivity;
            this.reason = reason;
        }
    }

    static final class DomSensitivity {
        final Sensitivity sensitivity;
        final String reason;
        final boolean hasPolicyConsent;

        DomSensitivity(Sensitivity sensitivity, String reason, boolean hasPolicyConsent) {
            this.sensitivity = sensitivity;
            this.reason = reason;
            this.hasPolicyConsent = hasPolicyConsent;
        }
    }

    private BotBrowserPolicy() { }

    static String ownerKey(String deviceId, String botId) {
        if (deviceId == null || deviceId.trim().isEmpty()) {
            throw new IllegalArgumentException("deviceId must be non-empty");
        }
        if (botId == null || botId.trim().isEmpty()) {
            throw new IllegalArgumentException("botId must be non-empty");
        }
        return deviceId + "\0" + botId;
    }

    /**
     * 每 Bot 稳定隔离的 WebView Profile 名称（纯 ASCII 小写十六进制，永不为 Default）。
     */
    static String profileNameForOwner(String deviceId, String botId) {
        String key = ownerKey(deviceId, botId);
        byte[] digest = sha256(key.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(PROFILE_PREFIX.length() + 32);
        hex.append(PROFILE_PREFIX);
        for (int i = 0; i < 16; i++) {
            int b = digest[i] & 0xFF;
            hex.append(Character.forDigit((b >>> 4) & 0xF, 16));
            hex.append(Character.forDigit(b & 0xF, 16));
        }
        String name = hex.toString();
        if (DEFAULT_PROFILE_NAME.equalsIgnoreCase(name)) {
            throw new IllegalStateException("Refusing default WebView profile");
        }
        return name;
    }

    /**
     * 校验并分类待导航 URL。非法 scheme / userInfo / 超长 / 控制字符抛出 BROWSER_NAVIGATION_BLOCKED；
     * Google OAuth / Center OAuth 回调 / Google 账号登录页标为 BLOCKED_EXTERNAL_AUTH。
     */
    static UrlCheck validateNavigationUrl(String rawUrl) throws BotBrowserBridge.Failure {
        if (rawUrl == null) {
            throw new BotBrowserBridge.Failure("INVALID_ARGUMENT", "url is required");
        }
        String trimmed = rawUrl.trim();
        if (trimmed.isEmpty() || trimmed.length() > MAX_URL_LENGTH || hasControlChars(trimmed)) {
            throw new BotBrowserBridge.Failure("BROWSER_NAVIGATION_BLOCKED", "URL is empty, oversized, or contains control characters");
        }
        if ("about:blank".equalsIgnoreCase(trimmed)) {
            return new UrlCheck("about:blank", Sensitivity.NORMAL, null);
        }
        URI uri;
        try {
            uri = new URI(trimmed);
        } catch (URISyntaxException invalid) {
            throw new BotBrowserBridge.Failure("BROWSER_NAVIGATION_BLOCKED", "Malformed URL");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!ALLOWED_SCHEMES.contains(scheme)) {
            throw new BotBrowserBridge.Failure("BROWSER_NAVIGATION_BLOCKED",
                    "Only http and https URLs are allowed in Bot browser");
        }
        if (uri.getRawUserInfo() != null) {
            throw new BotBrowserBridge.Failure("BROWSER_NAVIGATION_BLOCKED",
                    "URLs containing userInfo credentials are not allowed");
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            throw new BotBrowserBridge.Failure("BROWSER_NAVIGATION_BLOCKED", "URL must specify a valid host");
        }
        int port = uri.getPort();
        if (port != -1 && (port < 1 || port > 65535)) {
            throw new BotBrowserBridge.Failure("BROWSER_NAVIGATION_BLOCKED", "URL port is out of range");
        }
        String lowerHost = host.toLowerCase(Locale.ROOT);
        String rawPath = uri.getRawPath() == null ? "" : uri.getRawPath();
        String lowerPath = rawPath.toLowerCase(Locale.ROOT);

        // 硬红线：Google 账号登录 / MFA / OAuth 同意页与 Center OAuth 回调绝不进入 Bot WebView。
        if (lowerHost.equals("accounts.google.com") || lowerHost.endsWith(".accounts.google.com")) {
            return new UrlCheck(trimmed, Sensitivity.BLOCKED_EXTERNAL_AUTH,
                    "google_auth_requires_system_browser");
        }
        if (lowerPath.contains("/api/oauth/google/callback")) {
            return new UrlCheck(trimmed, Sensitivity.BLOCKED_EXTERNAL_AUTH,
                    "oauth_callback_requires_system_browser");
        }
        if (isGoogleHost(lowerHost) && (lowerPath.startsWith("/o/oauth2/")
                || lowerPath.startsWith("/signin/oauth")
                || lowerPath.startsWith("/o/openid2/"))) {
            return new UrlCheck(trimmed, Sensitivity.BLOCKED_EXTERNAL_AUTH,
                    "google_oauth_requires_system_browser");
        }

        // 敏感账号安全页、凭据/Secret 页面：阻断 Bot 观察、截图与自动点击。
        if (lowerHost.equals("myaccount.google.com")
                || lowerHost.endsWith(".myaccount.google.com")
                || lowerHost.equals("gds.google.com")) {
            return new UrlCheck(trimmed, Sensitivity.SECRET_SHIELD,
                    "google_account_security_shield");
        }
        if (lowerHost.equals("console.cloud.google.com")) {
            if (lowerPath.contains("/auth/clients/create")
                    || lowerPath.contains("/apis/credentials/oauthclient")) {
                // OAuth client 创建表单本身允许受限非敏感填写（如重定向 URI），但 Create/Secret 弹窗硬阻断；
                // client 详情页（已有 client ID）直接进入 SECRET_SHIELD 保护。
                return new UrlCheck(trimmed, Sensitivity.NORMAL, null);
            }
            if (lowerPath.contains("/auth/clients/")
                    || lowerPath.contains("/iam-admin/serviceaccounts/details/") && lowerPath.contains("/keys")
                    || lowerPath.contains("/billing/pay")) {
                return new UrlCheck(trimmed, Sensitivity.SECRET_SHIELD,
                        "cloud_console_secret_or_billing_shield");
            }
        }
        return new UrlCheck(trimmed, Sensitivity.NORMAL, null);
    }

    /**
     * 结合页面 URL 与实时 DOM 信号（密码框、OTP、支付、Client Secret 弹窗、政策勾选框）判定当前页敏感级别。
     */
    static DomSensitivity combineSensitivity(
            Sensitivity urlSensitivity,
            String urlReason,
            boolean hasPasswordField,
            boolean hasOtpField,
            boolean hasSecretDialog,
            boolean hasCardField,
            boolean hasPolicyConsent) {
        if (urlSensitivity == Sensitivity.BLOCKED_EXTERNAL_AUTH) {
            return new DomSensitivity(Sensitivity.BLOCKED_EXTERNAL_AUTH,
                    urlReason != null ? urlReason : "external_auth_required", hasPolicyConsent);
        }
        if (urlSensitivity == Sensitivity.SECRET_SHIELD) {
            return new DomSensitivity(Sensitivity.SECRET_SHIELD,
                    urlReason != null ? urlReason : "sensitive_page_shield", hasPolicyConsent);
        }
        if (hasSecretDialog) {
            return new DomSensitivity(Sensitivity.SECRET_SHIELD, "client_secret_dialog_detected", hasPolicyConsent);
        }
        if (hasPasswordField) {
            return new DomSensitivity(Sensitivity.SECRET_SHIELD, "password_input_detected", hasPolicyConsent);
        }
        if (hasOtpField) {
            return new DomSensitivity(Sensitivity.SECRET_SHIELD, "mfa_otp_input_detected", hasPolicyConsent);
        }
        if (hasCardField) {
            return new DomSensitivity(Sensitivity.SECRET_SHIELD, "payment_card_input_detected", hasPolicyConsent);
        }
        if (hasPolicyConsent) {
            return new DomSensitivity(Sensitivity.POLICY_CONSENT, "policy_consent_requires_human", true);
        }
        return new DomSensitivity(Sensitivity.NORMAL, null, false);
    }

    /**
     * 判断某个 DOM 控件是否属于禁止 Bot 代点/代填的红线边界：
     * - Google API Services: User Data Policy / Terms of Service / I agree 勾选或提交；
     * - OAuth Client Create / Download JSON / Show or Copy Secret；
     * - password / OTP / 支付输入框。
     */
    static boolean isSensitiveAgentControl(
            String url,
            String tag,
            String inputType,
            String autocomplete,
            String labelText) {
        String lowerType = inputType == null ? "" : inputType.trim().toLowerCase(Locale.ROOT);
        String lowerAuto = autocomplete == null ? "" : autocomplete.trim().toLowerCase(Locale.ROOT);
        String lowerLabel = labelText == null ? "" : labelText.trim().toLowerCase(Locale.ROOT);
        String lowerUrl = url == null ? "" : url.trim().toLowerCase(Locale.ROOT);

        if ("password".equals(lowerType)) return true;
        if (lowerAuto.contains("password") || lowerAuto.contains("one-time-code")
                || lowerAuto.startsWith("cc-")) {
            return true;
        }
        if (lowerLabel.contains("user data policy")
                || lowerLabel.contains("terms of service")
                || lowerLabel.contains("i agree to")
                || lowerLabel.contains("accept terms")
                || lowerLabel.contains("client secret")
                || lowerLabel.contains("download json")
                || lowerLabel.contains("copy secret")
                || lowerLabel.contains("show secret")
                || lowerLabel.contains("reset secret")) {
            return true;
        }
        boolean onOAuthClientPage = lowerUrl.contains("console.cloud.google.com")
                && (lowerUrl.contains("/apis/credentials/oauthclient")
                || lowerUrl.contains("/auth/clients/create")
                || lowerUrl.contains("/auth/clients"));
        if (onOAuthClientPage && (lowerLabel.equals("create")
                || lowerLabel.startsWith("create ")
                || lowerLabel.contains("create oauth")
                || lowerLabel.contains("create client"))) {
            return true;
        }
        boolean onAuthOverviewPage = lowerUrl.contains("console.cloud.google.com")
                && (lowerUrl.contains("/auth/overview/create") || lowerUrl.contains("/apis/credentials/consent"));
        if (onAuthOverviewPage && (lowerLabel.equals("finish") || lowerLabel.equals("create"))) {
            return true;
        }
        return false;
    }

    /** 返回给 agent 的 URL 脱敏：敏感页剥离 query/fragment，防止 state/code/token 泄漏。 */
    static String sanitizeUrlForSource(String url, Sensitivity sensitivity, String source) {
        if (url == null || url.isEmpty()) return "about:blank";
        if (!sensitivity.isSensitive() && !"agent".equals(source)) return url;
        if (!sensitivity.isSensitive()) return url;
        try {
            URI uri = new URI(url);
            if (uri.getScheme() == null || uri.getHost() == null) return "about:blank";
            StringBuilder clean = new StringBuilder();
            clean.append(uri.getScheme().toLowerCase(Locale.ROOT)).append("://").append(uri.getHost().toLowerCase(Locale.ROOT));
            if (uri.getPort() != -1) clean.append(':').append(uri.getPort());
            String path = uri.getRawPath();
            if (path != null && !path.isEmpty()) clean.append(path);
            return clean.toString();
        } catch (URISyntaxException ignored) {
            return "about:blank";
        }
    }

    static boolean isAllowedActKind(String kind) {
        return kind != null && ACT_KINDS.contains(kind);
    }

    static boolean isAllowedInputKind(String kind) {
        return kind != null && INPUT_KINDS.contains(kind);
    }

    static boolean isValidElementRef(String ref) {
        return ref != null && REF_PATTERN.matcher(ref).matches();
    }

    static Integer resolveKeyCode(String keyName) {
        if (keyName == null || keyName.isEmpty()) return null;
        if (" ".equals(keyName)) return KeyEvent.KEYCODE_SPACE;
        return KEY_CODES.get(keyName.trim().toUpperCase(Locale.ROOT));
    }

    static boolean hasControlChars(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x20 || c == 0x7F) return true;
        }
        return false;
    }

    /** 安全的 JS 字符串字面量转义（含 \u2028/\u2029 与控制字符），仅用于固定受控模板参数。 */
    static String jsStringLiteral(String value) {
        if (value == null) return "null";
        StringBuilder out = new StringBuilder(value.length() + 2);
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\': out.append("\\\\"); break;
                case '"': out.append("\\\""); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                case '<': out.append("\\u003c"); break;
                case '>': out.append("\\u003e"); break;
                case '\u2028': out.append("\\u2028"); break;
                case '\u2029': out.append("\\u2029"); break;
                default:
                    if (c < 0x20) {
                        out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
        return out.toString();
    }

    private static boolean isGoogleHost(String lowerHost) {
        return lowerHost.equals("google.com") || lowerHost.endsWith(".google.com");
    }

    private static byte[] sha256(byte[] input) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(input);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }
}
