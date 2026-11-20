package com.example.launcherprobe;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.Set;

/**
 * 最小原生系统浏览器打开器：仅允许受信 Center HTTPS origin 与固定 Google 授权/控制台页，
 * 始终以 ACTION_VIEW + CATEGORY_BROWSABLE 交由系统浏览器打开，绝不进入应用内 WebView。
 */
final class TrustedExternalOpener {
    private static final int MAX_URL_LENGTH = 4096;
    private static final Set<String> TRUSTED_GOOGLE_HOSTS = Set.of(
            "accounts.google.com",
            "console.cloud.google.com",
            "myaccount.google.com",
            "support.google.com"
    );

    private TrustedExternalOpener() { }

    /**
     * 校验待在系统浏览器打开的外部授权/控制台 URL。
     * 仅接受 HTTPS、无 userInfo、无控制字符、有界长度，且命中受信 Google 主机（默认 443 端口）
     * 或与当前已配置 Center 的 HTTPS origin（scheme + host + port）完全一致。
     */
    static String validateUrl(String rawUrl, String trustedCenterUrl) {
        if (rawUrl == null) {
            throw new IllegalArgumentException("外部授权地址不能为空");
        }
        String trimmed = rawUrl.trim();
        if (trimmed.isEmpty() || trimmed.length() > MAX_URL_LENGTH || BotBrowserPolicy.hasControlChars(trimmed)) {
            throw new IllegalArgumentException("外部授权地址格式或长度无效");
        }
        URI target = parseHttpsUri(trimmed, "外部授权地址必须是合法 HTTPS URL");
        String host = target.getHost().toLowerCase(Locale.ROOT);
        int port = effectiveHttpsPort(target);

        if (TRUSTED_GOOGLE_HOSTS.contains(host)) {
            if (port != 443) {
                throw new IllegalArgumentException("Google 授权页仅允许标准 443 端口");
            }
            return trimmed;
        }

        if (trustedCenterUrl != null && !trustedCenterUrl.trim().isEmpty()) {
            URI center = parseOptionalHttpsUri(trustedCenterUrl.trim());
            if (center != null
                    && host.equals(center.getHost().toLowerCase(Locale.ROOT))
                    && port == effectiveHttpsPort(center)) {
                return trimmed;
            }
        }

        throw new IllegalArgumentException("仅允许打开受信 Center origin 或 Google 授权/控制台页面");
    }

    /** 在系统浏览器中打开已通过 validateUrl 校验的 URL。 */
    static void launch(Activity activity, String validatedUrl) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(validatedUrl));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        activity.startActivity(intent);
    }

    private static URI parseHttpsUri(String value, String errorMessage) {
        URI uri = parseOptionalHttpsUri(value);
        if (uri == null) {
            throw new IllegalArgumentException(errorMessage);
        }
        return uri;
    }

    private static URI parseOptionalHttpsUri(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_URL_LENGTH
                || BotBrowserPolicy.hasControlChars(value)) {
            return null;
        }
        URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException ignored) {
            return null;
        }
        if (uri.getScheme() == null || !"https".equalsIgnoreCase(uri.getScheme())) return null;
        if (uri.getRawUserInfo() != null) return null;
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return null;
        int port = uri.getPort();
        if (port != -1 && (port < 1 || port > 65535)) return null;
        return uri;
    }

    private static int effectiveHttpsPort(URI uri) {
        int port = uri.getPort();
        return port == -1 ? 443 : port;
    }
}
