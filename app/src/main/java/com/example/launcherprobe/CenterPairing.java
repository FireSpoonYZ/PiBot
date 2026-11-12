package com.example.launcherprobe;

import android.content.Context;
import android.os.Build;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.CertPathValidatorException;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.BufferedSource;

/**
 * C7 配对/修复：在 :tauri_ui 进程的配对 worker 线程上同步执行。
 * 所有者口令只存在于本次会话的内存（请求体+CSRF/cookie 随调用结束丢弃），
 * 设备令牌只写既有持久化层（saveCenterSettings 桥 op + CenterClientCredentials 文件），
 * 不进入日志，也不返回给 web。
 *
 * Host 身份优先 snapshot（prefs device_id），没有就走既有 settingsGet 桥 op：
 * 离线 settings 子进程 openHost 物化 host.sqlite/host_identity——不启动 Agent/FGS/Runtime。
 * POST /api/devices 带 deviceId+replaceExisting，让 Host 以自身身份登记（父确认的中心扩展）。
 */
final class CenterPairing {

    private static final MediaType JSON_MEDIA = MediaType.get("application/json; charset=utf-8");
    private static final long CONNECT_TIMEOUT_MS = 15_000;
    /** 整 call 总期限（连接+读写+慢速流），单个 HTTP 步都受它约束。 */
    private static final long CALL_TIMEOUT_MS = 45_000;
    private static final long MAX_BODY_BYTES = 64 * 1024;
    private static final int MAX_PASSWORD_CHARS = 1024;
    private static final int MAX_URL_CHARS = 2048;
    private static final int MAX_CA_CHARS = 64 * 1024;
    private static final Pattern DEVICE_TOKEN = Pattern.compile("[A-Za-z0-9_-]{32,512}");

    private CenterPairing() {
    }

    /**
     * 阻塞执行：必须在插件配对 worker 线程调用，禁止主线程。
     * ownerOpen 为"UI 会话仍存活"判定：登记提交点之前随时中止；一旦 POST /api/devices 成功，
     * 后续持久化/连接照常完成——凭据已是可恢复态，不能半途丢弃。
     */
    static JSONObject pair(Context context, BotHostUiBridgeClient bridge, JSONObject params,
                           BooleanSupplier ownerOpen) throws Exception {
        String url = normalizeCenterUrl(params.optString("url", ""));
        String password = stringArg(params, "password");
        if (password.isEmpty() || password.length() > MAX_PASSWORD_CHARS) {
            throw new BridgeException("INVALID_ARGS", "not-sent", "所有者口令无效");
        }
        String displayName = displayNameOf(params);
        String ca = params.optString("ca", "").trim();
        if (ca.length() > MAX_CA_CHARS) {
            throw new BridgeException("INVALID_ARGS", "not-sent", "CA 证书过大");
        }
        boolean force = params.optBoolean("force", false);

        Context appContext = context.getApplicationContext();
        CenterClientCredentials credentials = new CenterClientCredentials(appContext);
        if (!force) rejectIfBound(credentials, bridge);

        String deviceId = resolveHostDeviceId(bridge);
        if (!ownerOpen.getAsBoolean()) {
            throw new BridgeException("CANCELLED", "not-sent", "界面已结束");
        }

        // ---------- 所有者会话流：GET /api/session → POST → GET → POST /api/devices ----------
        Session session = new Session(ca);
        JSONObject first = session.request("GET", url + "/api/session", null, null, null);
        String csrf = first.optString("csrfToken", "");
        if (csrf.isEmpty()) {
            throw new BridgeException("CENTER_ERROR", "not-sent", "中心未返回 CSRF 令牌");
        }
        JSONObject auth = session.request("POST", url + "/api/session",
                new JSONObject().put("password", password), csrf, "所有者口令无效");
        if (!auth.optBoolean("authenticated", false)) {
            throw new BridgeException("OWNER_AUTH_FAILED", "not-sent", "所有者口令无效");
        }
        JSONObject second = session.request("GET", url + "/api/session", null, null, null);
        if (!second.optBoolean("authenticated", false)) {
            throw new BridgeException("OWNER_AUTH_FAILED", "not-sent", "中心会话未生效");
        }
        csrf = second.optString("csrfToken", "");
        if (csrf.isEmpty()) {
            throw new BridgeException("CENTER_ERROR", "not-sent", "中心未返回 CSRF 令牌");
        }
        if (!ownerOpen.getAsBoolean()) {
            throw new BridgeException("CANCELLED", "not-sent", "界面已结束");
        }
        android.content.SharedPreferences pending = pendingPrefs(appContext);
        String requestedToken = requestedToken(pending, url + "\n" + deviceId + "\n" + force);
        JSONObject created = session.request("POST", url + "/api/devices",
                new JSONObject().put("displayName", displayName)
                        .put("platform", "android")
                        .put("deviceId", deviceId)
                        .put("deviceToken", requestedToken)
                        .put("replaceExisting", force),
                csrf, "中心会话或 CSRF 校验失败");
        verifyRegistered(created, deviceId, requestedToken);
        return persistAndConnect(bridge, pending, url, deviceId, requestedToken, ca,
                created.optString("displayName", displayName));
    }

    /**
     * 配对码配对：地址、一次性密钥与私有 CA 都在码里，用户无需再输入任何内容。
     * 设备自带 Host 身份与令牌，凭一次性密钥直接向中心兑换（不需要所有者会话/CSRF）；
     * 之后的持久化与连接与所有者密码配对完全相同。同一设备同一令牌、同一个码重试不会另生令牌，
     * 所以响应丢失后可以用同一个码重试（中心在 10 分钟内接受同设备同令牌的重放）；换新码则换新令牌。
     * 兑换前不碰任何持久状态：被中心拒绝（码已用/过期/设备不符）时本机绑定原样保留。
     */
    static JSONObject pairWithCode(Context context, BotHostUiBridgeClient bridge, JSONObject params,
                                   BooleanSupplier ownerOpen) throws Exception {
        PairingCode code = PairingCode.parse(stringArg(params, "code"));
        String displayName = displayNameOf(params);
        boolean force = params.optBoolean("force", false);

        Context appContext = context.getApplicationContext();
        CenterClientCredentials credentials = new CenterClientCredentials(appContext);
        if (!force) rejectIfBound(credentials, bridge);

        String deviceId = resolveHostDeviceId(bridge);
        if (!ownerOpen.getAsBoolean()) {
            throw new BridgeException("CANCELLED", "not-sent", "界面已结束");
        }
        android.content.SharedPreferences pending = pendingPrefs(appContext);
        String requestedToken = requestedToken(pending, redeemPendingKey(code.url, deviceId, code.secret));
        JSONObject created = new Session(code.ca).redeem(code.url + "/api/pairing/redeem",
                new JSONObject().put("code", code.secret)
                        .put("deviceId", deviceId)
                        .put("deviceToken", requestedToken)
                        .put("displayName", displayName)
                        .put("platform", "android"));
        verifyRegistered(created, deviceId, requestedToken);
        return persistAndConnect(bridge, pending, code.url, deviceId, requestedToken, code.ca,
                created.optString("displayName", displayName));
    }

    /** 设备名：缺省用机型，≤64 字符，不含控制字符。 */
    private static String displayNameOf(JSONObject params) throws BridgeException {
        String displayName = params.optString("displayName", "").trim();
        if (displayName.isEmpty()) {
            displayName = Build.MODEL != null ? Build.MODEL.trim() : "";
            if (displayName.isEmpty()) displayName = "Android";
        }
        if (displayName.length() > 64) displayName = displayName.substring(0, 64);
        for (int i = 0; i < displayName.length(); i++) {
            if (Character.isISOControl(displayName.charAt(i))) {
                throw new BridgeException("INVALID_ARGS", "not-sent", "设备名不能包含控制字符");
            }
        }
        return displayName;
    }

    /** 已有绑定默认拒绝：客户端凭据文件或 Host 中心令牌任一存在即视为已绑定。 */
    private static void rejectIfBound(CenterClientCredentials credentials, BotHostUiBridgeClient bridge)
            throws Exception {
        JSONObject saved = null;
        try {
            saved = credentials.read();
        } catch (Exception failure) {
            throw new BridgeException("CREDENTIALS", "not-sent",
                    "已保存的中心凭据无法读取，请修复存储或用 force 重新配对");
        }
        boolean bound = saved != null;
        if (!bound) {
            JSONObject settings = await(bridge.request("centerSettings", new JSONObject()));
            bound = settings != null && settings.optBoolean("tokenConfigured");
        }
        if (bound) {
            throw new BridgeException("ALREADY_CONFIGURED", "not-sent",
                    "设备已绑定中心，只有显式 force 才能替换");
        }
    }

    private static android.content.SharedPreferences pendingPrefs(Context appContext) {
        return appContext.getSharedPreferences("center_pairing", Context.MODE_PRIVATE);
    }

    /**
     * 配对码兑换的待确认令牌键：除了中心与设备，还绑定到这一个码（只记一次性密钥的 SHA-256）。
     * 同一个码在响应丢失后重试沿用原令牌（中心在重放窗口内认同设备同令牌）；换新码则必须换新令牌——
     * 否则中心已登记了上一次丢响应的请求、所有者又删除了该设备时，新码会带着已登记的旧令牌来加回，
     * 中心不会把已撤销设备“轮换”到它本来就持有的令牌上，之后换任何码都会一直 409。
     */
    static String redeemPendingKey(String url, String deviceId, String secret) {
        return url + "\n" + deviceId + "\nredeem\n" + sha256Hex(secret);
    }

    private static String sha256Hex(String value) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** 待确认令牌：同一 key 重试复用，登记成功后由 persistAndConnect 清除。 */
    static String requestedToken(android.content.SharedPreferences pending, String pendingKey)
            throws BridgeException {
        String requestedToken = pendingKey.equals(pending.getString("key", null))
                ? pending.getString("token", null) : null;
        if (requestedToken == null) {
            byte[] random = new byte[32];
            new java.security.SecureRandom().nextBytes(random);
            requestedToken = android.util.Base64.encodeToString(random,
                    android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
            if (!pending.edit().putString("key", pendingKey).putString("token", requestedToken).commit()) {
                throw new BridgeException("CREDENTIALS", "not-sent", "无法保存待配对凭据");
            }
        }
        return requestedToken;
    }

    /** 响应不可信：只校验不执行远端副作用；不匹配即失败，由用户重新发起。 */
    private static void verifyRegistered(JSONObject created, String deviceId, String requestedToken)
            throws BridgeException {
        String registeredId = created.optString("deviceId", "");
        String token = created.optString("deviceToken", "");
        if (!deviceId.equals(registeredId)) {
            throw new BridgeException("CENTER_ERROR", "not-sent",
                    "中心未按请求登记本机 Host 身份");
        }
        if (!DEVICE_TOKEN.matcher(token).matches() || !token.equals(requestedToken)) {
            throw new BridgeException("CENTER_ERROR", "not-sent", "中心返回的设备令牌无效");
        }
    }

    /**
     * 先持久化、再连接；登记成功后续步骤不因 UI 关闭丢弃。
     * 单一写入方：storeCenterCredentials 在默认进程 client 串行队列内失效旧连接代后再保存，
     * 旧后台 connect 的迟到 persistReady 无法覆盖新凭据（displayName 随记录供 repair 回显）。
     */
    private static JSONObject persistAndConnect(BotHostUiBridgeClient bridge,
                                                android.content.SharedPreferences pending,
                                                String url, String deviceId, String token, String ca,
                                                String displayName) throws Exception {
        JSONArray warnings = new JSONArray();
        await(bridge.request("storeCenterCredentials", new JSONObject()
                .put("input", new JSONObject()
                        .put("url", url).put("deviceId", deviceId)
                        .put("deviceToken", token).put("ca", ca)
                        .put("displayName", displayName))));
        pending.edit().clear().commit();
        boolean hostConfigured = false;
        try {
            await(bridge.request("saveCenterSettings", new JSONObject()
                    .put("input", new JSONObject()
                            .put("url", url).put("deviceToken", token).put("ca", ca))));
            hostConfigured = true;
        } catch (Throwable failure) {
            warnings.put(warning("HOST_CONFIG_FAILED", failure));
        }
        boolean connectionRequested = false;
        try {
            // deviceToken:"" 走 BotHostClient 既有"读已存凭据并校验 url/deviceId/ca"路径。
            await(bridge.request("clientRequest", new JSONObject()
                    .put("op", "center_connect")
                    .put("params", new JSONObject()
                            .put("url", url).put("deviceId", deviceId)
                            .put("deviceToken", "").put("ca", ca))));
            connectionRequested = true;
        } catch (Throwable failure) {
            warnings.put(warning("CONNECT_FAILED", failure));
        }
        return result(url, deviceId, displayName, hostConfigured, connectionRequested, warnings);
    }

    /**
     * 绑定修复（repairCenterBinding {}）：只读既有 client 凭据重发 saveCenterSettings+center_connect，
     * 供 hostConfigured=false 局部重试；不需要所有者口令、不注册新设备。返回同 PairCenterResult。
     */
    static JSONObject repair(Context context, BotHostUiBridgeClient bridge) throws Exception {
        Context appContext = context.getApplicationContext();
        CenterClientCredentials credentials = new CenterClientCredentials(appContext);
        JSONObject saved;
        try {
            saved = credentials.read();
        } catch (Exception failure) {
            throw new BridgeException("CREDENTIALS", "not-sent",
                    "已保存的中心凭据无法读取，请重新配对");
        }
        if (saved == null) {
            throw new BridgeException("NOT_CONFIGURED", "not-sent", "设备尚未绑定中心");
        }
        String url = saved.getString("url");
        String deviceId = saved.getString("deviceId");
        String token = saved.getString("deviceToken");
        String ca = saved.optString("ca", "");
        String displayName = saved.optString("displayName", "");

        JSONArray warnings = new JSONArray();
        boolean hostConfigured = false;
        try {
            await(bridge.request("saveCenterSettings", new JSONObject()
                    .put("input", new JSONObject()
                            .put("url", url).put("deviceToken", token).put("ca", ca))));
            hostConfigured = true;
        } catch (Throwable failure) {
            warnings.put(warning("HOST_CONFIG_FAILED", failure));
        }
        boolean connectionRequested = false;
        try {
            await(bridge.request("clientRequest", new JSONObject()
                    .put("op", "center_connect")
                    .put("params", new JSONObject()
                            .put("url", url).put("deviceId", deviceId)
                            .put("deviceToken", "").put("ca", ca))));
            connectionRequested = true;
        } catch (Throwable failure) {
            warnings.put(warning("CONNECT_FAILED", failure));
        }
        return result(url, deviceId, displayName, hostConfigured, connectionRequested, warnings);
    }

    private static JSONObject result(String url, String deviceId, String displayName,
                                     boolean hostConfigured, boolean connectionRequested,
                                     JSONArray warnings) throws JSONException {
        JSONObject result = new JSONObject()
                .put("centerUrl", url)
                .put("deviceId", deviceId)
                .put("displayName", displayName)
                .put("hostConfigured", hostConfigured)
                .put("connectionRequested", connectionRequested);
        if (warnings.length() > 0) result.put("warnings", warnings);
        return result;
    }

    /** Host 身份：先 prefs device_id（Host 跑过即有），再 settingsGet 物化既有 host_identity。 */
    private static String resolveHostDeviceId(BotHostUiBridgeClient bridge) throws Exception {
        String deviceId = stringField(await(bridge.request("snapshot", new JSONObject())), "deviceId");
        if (deviceId.isEmpty()) {
            deviceId = stringField(await(bridge.request("settingsGet", new JSONObject())), "deviceId");
        }
        if (deviceId.isEmpty()) {
            throw new BridgeException("UNAVAILABLE", "not-sent", "无法取得本机 Host 身份");
        }
        return deviceId;
    }

    /** HostSnapshot.deviceId 契约可为 JSON null/非串：只认非空 String，不把 NULL.toString 当身份。 */
    private static String stringField(JSONObject object, String key) {
        if (object == null) return "";
        Object value = object.opt(key);
        return value instanceof String ? (String) value : "";
    }

    private static JSONObject await(CompletableFuture<JSONObject> future) throws Exception {
        try {
            return future.join();
        } catch (RuntimeException failure) {
            Throwable cause = failure instanceof CompletionException && failure.getCause() != null
                    ? failure.getCause() : failure;
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IOException(cause);
        }
    }

    private static JSONObject warning(String code, Throwable failure) throws JSONException {
        return new JSONObject()
                .put("code", code)
                .put("message", messageOf(failure));
    }

    private static String messageOf(Throwable failure) {
        String message = failure != null ? failure.getMessage() : null;
        if (message == null || message.isEmpty()) return "操作失败";
        return message.length() > 200 ? message.substring(0, 200) : message;
    }

    /** 兑换被中心拒绝：保留中心错误码并给出可操作的说明，让用户知道是码、设备还是中心版本的问题。 */
    static BridgeException redeemFailure(int status, String body) {
        String code = errorCodeOf(body);
        if ("PAIRING_CODE_INVALID".equals(code)) {
            return new BridgeException(code, "not-sent", "配对码无效，请在中心重新生成");
        }
        if ("PAIRING_CODE_USED".equals(code)) {
            return new BridgeException(code, "not-sent", "配对码已被使用，请在中心重新生成");
        }
        if ("PAIRING_CODE_EXPIRED".equals(code)) {
            return new BridgeException(code, "not-sent", "配对码已过期（10 分钟有效），请在中心重新生成");
        }
        if ("PAIRING_CODE_REVOKED".equals(code)) {
            return new BridgeException(code, "not-sent",
                    "配对码已作废：中心的「添加设备」窗口被关闭了。复制或扫描后请保持该窗口打开，直到配对完成；需要的话重新生成");
        }
        if ("DEVICE_ALREADY_REGISTERED".equals(code)) {
            return new BridgeException(code, "not-sent",
                    "中心上已有这台设备的记录，新配对码不能顶替它。请所有者在管理页「设备与 Bot」里点该设备的"
                            + "「重新配对」，使用生成的专属配对码");
        }
        if ("PAIRING_CODE_DEVICE_MISMATCH".equals(code)) {
            return new BridgeException(code, "not-sent", "这个配对码是为另一台设备生成的，不能用于本机。请在中心为本机重新生成");
        }
        if (status == 429) {
            return new BridgeException("RATE_LIMITED", "not-sent", "中心请求过于频繁，请稍后重试");
        }
        if (status == 404 || status == 405) {
            return new BridgeException("CENTER_UNSUPPORTED", "not-sent",
                    "该中心版本尚不支持配对码，请升级中心，或改用所有者密码配对");
        }
        String detail = Session.errorDetail(body);
        return new BridgeException("CENTER_ERROR", "not-sent", detail != null ? detail : "中心返回错误 " + status);
    }

    /** 中心错误体 {@code {error:{code}}} 里的 code；取不到返回 null。 */
    static String errorCodeOf(String text) {
        if (text == null || text.isEmpty() || text.length() > MAX_BODY_BYTES) return null;
        try {
            Object error = new JSONObject(text).opt("error");
            if (!(error instanceof JSONObject)) return null;
            String code = ((JSONObject) error).optString("code", "");
            return code.isEmpty() ? null : code;
        } catch (JSONException invalid) {
            return null;
        }
    }

    /**
     * 证书校验失败（不受信任的签发者、主机名不符、已过期）：中心其实应答了，只是本机不信任它。
     * 与网络不通分开说，否则私有 CA 没进配对码时用户只会看到“无法连接中心”。
     */
    static boolean isCertificateFailure(Throwable failure) {
        Throwable current = failure;
        for (int depth = 0; current != null && depth < 8; depth++) {
            if (current instanceof SSLPeerUnverifiedException
                    || current instanceof CertificateException
                    || current instanceof CertPathValidatorException) {
                return true;
            }
            if (current.getCause() == current) break;
            current = current.getCause();
        }
        return false;
    }

    static BridgeException transportFailure(Throwable failure) {
        if (isCertificateFailure(failure)) {
            return new BridgeException("CENTER_CERT_UNTRUSTED", "not-sent",
                    "能连上中心，但本机不信任它的证书。中心使用自签或私有 CA 时，请所有者在管理页「添加设备」窗口保存"
                            + "私有 CA 后重新生成配对码；用所有者密码配对时，在 CA 证书栏填写它");
        }
        return new BridgeException("CENTER_UNREACHABLE", "not-sent", "无法连接中心");
    }

    /** 与 saveCenterSettings 一致：仅 HTTPS origin，路径为空或 "/"（不保留前缀）；长度有界。 */
    static String normalizeCenterUrl(String raw) throws BridgeException {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty() || value.length() > MAX_URL_CHARS) {
            throw new BridgeException("INVALID_ARGS", "not-sent", "中心地址无效");
        }
        URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException invalid) {
            throw new BridgeException("INVALID_ARGS", "not-sent", "中心地址无效");
        }
        String path = uri.getRawPath();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                || (path != null && !path.isEmpty() && !"/".equals(path))) {
            throw new BridgeException("INVALID_ARGS", "not-sent", "中心地址必须是 HTTPS 地址");
        }
        String normalized = uri.toASCIIString();
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    private static String stringArg(JSONObject params, String key) throws BridgeException {
        Object value = params.opt(key);
        if (value == null || value == JSONObject.NULL || !(value instanceof String)) {
            throw new BridgeException("INVALID_ARGS", "not-sent", "缺少 " + key);
        }
        return (String) value;
    }

    /** 单次配对会话：OkHttp + 仅同源 Set-Cookie 内存合并；禁重定向；CA 与系统根组合，主机名仍校验。 */
    private static final class Session {
        private final OkHttpClient client;
        private final Map<String, String> cookies = new LinkedHashMap<>();

        Session(String ca) throws BridgeException {
            OkHttpClient.Builder builder = new OkHttpClient.Builder()
                    .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                    .callTimeout(CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                    .followRedirects(false)
                    .followSslRedirects(false);
            if (ca != null && !ca.isEmpty()) {
                X509TrustManager trustManager = trustManager(ca);
                try {
                    SSLContext context = SSLContext.getInstance("TLS");
                    context.init(null, new TrustManager[]{trustManager}, null);
                    builder.sslSocketFactory(context.getSocketFactory(), trustManager);
                } catch (Exception failure) {
                    throw new BridgeException("INVALID_ARGS", "not-sent", "CA 证书无效");
                }
            }
            client = builder.build();
        }

        /** 自定义 CA 与默认系统根组合：先自签名校验、失败回退系统链；单一实例同时供 SSLContext 与 OkHttp。 */
        private static X509TrustManager trustManager(String ca) throws BridgeException {
            final X509TrustManager custom;
            final X509TrustManager system;
            try {
                TrustManagerFactory factory = TrustManagerFactory.getInstance(
                        TrustManagerFactory.getDefaultAlgorithm());
                factory.init(keyStore(ca));
                custom = firstX509(factory);
                TrustManagerFactory defaults = TrustManagerFactory.getInstance(
                        TrustManagerFactory.getDefaultAlgorithm());
                defaults.init((KeyStore) null);
                system = firstX509(defaults);
            } catch (BridgeException failure) {
                throw failure;
            } catch (Exception failure) {
                throw new BridgeException("INVALID_ARGS", "not-sent", "CA 证书无效");
            }
            return new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType)
                        throws CertificateException {
                    system.checkClientTrusted(chain, authType);
                }

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType)
                        throws CertificateException {
                    try {
                        custom.checkServerTrusted(chain, authType);
                    } catch (CertificateException failure) {
                        system.checkServerTrusted(chain, authType);
                    }
                }

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    X509Certificate[] a = custom.getAcceptedIssuers();
                    X509Certificate[] b = system.getAcceptedIssuers();
                    X509Certificate[] all = new X509Certificate[a.length + b.length];
                    System.arraycopy(a, 0, all, 0, a.length);
                    System.arraycopy(b, 0, all, a.length, b.length);
                    return all;
                }
            };
        }

        private static X509TrustManager firstX509(TrustManagerFactory factory)
                throws BridgeException {
            for (TrustManager manager : factory.getTrustManagers()) {
                if (manager instanceof X509TrustManager) return (X509TrustManager) manager;
            }
            throw new BridgeException("INVALID_ARGS", "not-sent", "CA 证书无效");
        }

        private static KeyStore keyStore(String ca) throws Exception {
            CertificateFactory factory = CertificateFactory.getInstance("X.509");
            Collection<? extends Certificate> certificates = factory.generateCertificates(
                    new ByteArrayInputStream(ca.getBytes(StandardCharsets.UTF_8)));
            if (certificates.isEmpty()) {
                throw new BridgeException("INVALID_ARGS", "not-sent", "CA 证书无效");
            }
            KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
            store.load(null, null);
            int index = 0;
            for (Certificate certificate : certificates) {
                store.setCertificateEntry("ca" + index++, certificate);
            }
            return store;
        }

        /** authFailedMessage 为 null 时 401/403 也归并到 CENTER_ERROR（CSRF/会话失效非口令问题）。 */
        JSONObject request(String method, String url, JSONObject body, String csrf,
                           String authFailedMessage) throws BridgeException {
            Reply reply = exchange(method, url, body, csrf);
            int code = reply.code;
            String text = reply.text;
            if (code >= 200 && code < 300) return parseSuccess(text);
            String detail = errorDetail(text);
            if (code == 401 || code == 403) {
                if (authFailedMessage != null) {
                    throw new BridgeException("OWNER_AUTH_FAILED", "not-sent", authFailedMessage);
                }
                throw new BridgeException("CENTER_ERROR", "not-sent",
                        detail != null ? detail : "中心会话或 CSRF 校验失败");
            }
            if (code == 429) {
                throw new BridgeException("RATE_LIMITED", "not-sent", "中心请求过于频繁，请稍后重试");
            }
            if (code == 409) {
                throw new BridgeException("ALREADY_CONFIGURED", "not-sent",
                        detail != null ? detail : "设备已在中心登记，请启用 force 替换");
            }
            throw new BridgeException("CENTER_ERROR", "not-sent",
                    detail != null ? detail : "中心返回错误 " + code);
        }

        /** 设备端兑换配对码：不带会话与 CSRF，凭一次性密钥授权；被拒时按中心错误码给出可操作的原因。 */
        JSONObject redeem(String url, JSONObject body) throws BridgeException {
            Reply reply = exchange("POST", url, body, null);
            if (reply.code >= 200 && reply.code < 300) return parseSuccess(reply.text);
            throw redeemFailure(reply.code, reply.text);
        }

        private static JSONObject parseSuccess(String text) throws BridgeException {
            if (text.isEmpty()) return new JSONObject();
            try {
                return new JSONObject(text);
            } catch (JSONException invalid) {
                throw new BridgeException("CENTER_ERROR", "not-sent", "中心响应无效");
            }
        }

        /** 一次 HTTP 往返：传输失败按原因分类（证书不受信任与网络不通要分开说），响应体有界读取。 */
        private Reply exchange(String method, String url, JSONObject body, String csrf)
                throws BridgeException {
            Request.Builder request = new Request.Builder().url(url);
            if (!cookies.isEmpty()) request.header("Cookie", cookieHeader());
            if (csrf != null) request.header("x-csrf-token", csrf);
            request.method(method, body == null
                    ? null : RequestBody.create(JSON_MEDIA, body.toString()));
            Response response;
            try {
                response = client.newCall(request.build()).execute();
            } catch (IOException | RuntimeException failure) {
                throw transportFailure(failure);
            }
            int code = response.code();
            mergeCookies(response);
            String text;
            try {
                text = readBody(response);
                response.close();
            } catch (IOException failure) {
                response.close();
                throw transportFailure(failure);
            }
            return new Reply(code, text);
        }

        private static final class Reply {
            final int code;
            final String text;

            Reply(int code, String text) {
                this.code = code;
                this.text = text;
            }
        }

        private void mergeCookies(Response response) {
            for (String header : response.headers("Set-Cookie")) {
                int semicolon = header.indexOf(';');
                String pair = semicolon >= 0 ? header.substring(0, semicolon) : header;
                int equals = pair.indexOf('=');
                if (equals <= 0) continue;
                String name = pair.substring(0, equals).trim();
                String value = pair.substring(equals + 1).trim();
                if (!name.isEmpty()) {
                    if (value.isEmpty()) cookies.remove(name);
                    else cookies.put(name, value);
                }
            }
        }

        private String cookieHeader() {
            StringBuilder builder = new StringBuilder();
            for (Map.Entry<String, String> entry : cookies.entrySet()) {
                if (builder.length() > 0) builder.append("; ");
                builder.append(entry.getKey()).append('=').append(entry.getValue());
            }
            return builder.toString();
        }

        /** 有界响应体读取：超过 MAX_BODY_BYTES 视为协议异常。 */
        private static String readBody(Response response) throws IOException {
            ResponseBody body = response.body();
            if (body == null) return "";
            BufferedSource source = body.source();
            source.request(MAX_BODY_BYTES + 1);
            Buffer data = new Buffer();
            source.read(data, MAX_BODY_BYTES + 1);
            if (data.size() > MAX_BODY_BYTES) {
                throw new IOException("response too large");
            }
            return data.readUtf8();
        }

        /** 错误体里尽力取 message；不解析大对象，绝不回传凭据。 */
        private static String errorDetail(String text) {
            if (text == null || text.isEmpty() || text.length() > MAX_BODY_BYTES) return null;
            try {
                JSONObject json = new JSONObject(text);
                Object error = json.opt("error");
                if (error instanceof JSONObject) {
                    String message = ((JSONObject) error).optString("message", "");
                    if (!message.isEmpty()) return message;
                }
                String message = json.optString("message", "");
                return message.isEmpty() ? null : message;
            } catch (JSONException invalid) {
                return null;
            }
        }
    }
}
