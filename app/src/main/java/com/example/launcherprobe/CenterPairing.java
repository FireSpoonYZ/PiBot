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
        String ca = params.optString("ca", "").trim();
        if (ca.length() > MAX_CA_CHARS) {
            throw new BridgeException("INVALID_ARGS", "not-sent", "CA 证书过大");
        }
        boolean force = params.optBoolean("force", false);

        Context appContext = context.getApplicationContext();
        CenterClientCredentials credentials = new CenterClientCredentials(appContext);

        // 已有绑定默认拒绝：客户端凭据文件或 Host 中心令牌任一存在即视为已绑定。
        if (!force) {
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
        android.content.SharedPreferences pending = appContext.getSharedPreferences("center_pairing", Context.MODE_PRIVATE);
        String pendingKey = url + "\n" + deviceId + "\n" + force;
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
        JSONObject created = session.request("POST", url + "/api/devices",
                new JSONObject().put("displayName", displayName)
                        .put("platform", "android")
                        .put("deviceId", deviceId)
                        .put("deviceToken", requestedToken)
                        .put("replaceExisting", force),
                csrf, "中心会话或 CSRF 校验失败");

        String registeredId = created.optString("deviceId", "");
        String token = created.optString("deviceToken", "");
        // 响应不可信：只校验不执行远端副作用；不匹配即失败，由用户重新发起。
        if (!deviceId.equals(registeredId)) {
            throw new BridgeException("CENTER_ERROR", "not-sent",
                    "中心未按请求登记本机 Host 身份");
        }
        if (!DEVICE_TOKEN.matcher(token).matches() || !token.equals(requestedToken)) {
            throw new BridgeException("CENTER_ERROR", "not-sent", "中心返回的设备令牌无效");
        }

        // ---------- 先持久化、再连接；登记成功后续步骤不因 UI 关闭丢弃 ----------
        JSONArray warnings = new JSONArray();
        // 单一写入方：storeCenterCredentials 在默认进程 client 串行队列内失效旧连接代后再保存，
        // 旧后台 connect 的迟到 persistReady 无法覆盖新凭据（displayName 随记录供 repair 回显）。
        await(bridge.request("storeCenterCredentials", new JSONObject()
                .put("input", new JSONObject()
                        .put("url", url).put("deviceId", deviceId)
                        .put("deviceToken", token).put("ca", ca)
                        .put("displayName", created.optString("displayName", displayName)))));
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
        return result(url, deviceId, created.optString("displayName", displayName),
                hostConfigured, connectionRequested, warnings);
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

    /** 与 saveCenterSettings 一致：仅 HTTPS origin，路径为空或 "/"（不保留前缀）；长度有界。 */
    private static String normalizeCenterUrl(String raw) throws BridgeException {
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
            Request.Builder request = new Request.Builder().url(url);
            if (!cookies.isEmpty()) request.header("Cookie", cookieHeader());
            if (csrf != null) request.header("x-csrf-token", csrf);
            request.method(method, body == null
                    ? null : RequestBody.create(JSON_MEDIA, body.toString()));
            Response response;
            try {
                response = client.newCall(request.build()).execute();
            } catch (IOException | RuntimeException failure) {
                throw new BridgeException("CENTER_UNREACHABLE", "not-sent", "无法连接中心");
            }
            int code = response.code();
            mergeCookies(response);
            String text;
            try {
                text = readBody(response);
                response.close();
            } catch (IOException failure) {
                response.close();
                throw new BridgeException("CENTER_UNREACHABLE", "not-sent", "无法连接中心");
            }
            if (code >= 200 && code < 300) {
                if (text.isEmpty()) return new JSONObject();
                try {
                    return new JSONObject(text);
                } catch (JSONException invalid) {
                    throw new BridgeException("CENTER_ERROR", "not-sent", "中心响应无效");
                }
            }
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
