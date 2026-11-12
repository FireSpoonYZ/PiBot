package com.example.launcherprobe;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.regex.Pattern;

/**
 * 中心管理页签发的一次性配对码：{@code "pibot1." + base64url(JSON {u, c, a?})}，
 * {@code u} 为中心 HTTPS origin，{@code c} 为一次性密钥，{@code a} 为可选私有 CA（PEM）。
 *
 * 线格式由 center-server/pairing.js 定义，桌面端在 Rust 侧另有同构解码；这里是 Android 侧唯一的解码点。
 * 一次性密钥与 CA 只出现在原生进程内：web 层只传不透明的整串文本（粘贴或扫码得到的原文）。
 * toString 不含密钥，避免被日志带出。
 */
final class PairingCode {

    static final String PREFIX = "pibot1.";
    /** 与桌面端 pairing_code.rs 同限：整串上限与 CA 上限，先于解码拒绝异常长输入。 */
    private static final int MAX_CODE_CHARS = 96 * 1024;
    private static final int MAX_CA_CHARS = 64 * 1024;
    private static final Pattern SECRET = Pattern.compile("[A-Za-z0-9_-]{32,64}");
    private static final Pattern BASE64_URL = Pattern.compile("[A-Za-z0-9_-]+");
    private static final Pattern OTHER_VERSION = Pattern.compile("^pibot\\d+\\..*");

    /** 规整后的 HTTPS origin，无尾部斜杠。 */
    final String url;
    /** 一次性密钥：只用于兑换请求体，不落盘、不回传 web。 */
    final String secret;
    /** 私有 CA（PEM），没有时为空串。 */
    final String ca;

    private PairingCode(String url, String secret, String ca) {
        this.url = url;
        this.secret = secret;
        this.ca = ca;
    }

    /** 解码并校验；失败抛带固定 code 的 BridgeException（not-sent）。空白（含换行）一律忽略。 */
    static PairingCode parse(String text) throws BridgeException {
        String compact = text == null ? "" : text.replaceAll("\\s+", "");
        if (!compact.startsWith(PREFIX)) {
            if (OTHER_VERSION.matcher(compact).matches()) {
                throw new BridgeException("UNSUPPORTED_PAIRING_CODE", "not-sent",
                        "此配对码来自更新版本的中心，请先更新 pibot");
            }
            throw new BridgeException("NOT_A_PAIRING_CODE", "not-sent",
                    "这不是配对码。请在中心管理页的「设备与 Bot」点击「添加设备」获取");
        }
        if (compact.length() > MAX_CODE_CHARS) throw damaged();

        JSONObject payload = decodePayload(compact.substring(PREFIX.length()));
        Object u = payload.opt("u");
        Object c = payload.opt("c");
        Object a = payload.opt("a");
        if (!(u instanceof String) || !(c instanceof String) || !SECRET.matcher((String) c).matches()) {
            throw damaged();
        }
        if (a != null && a != JSONObject.NULL && !(a instanceof String)) throw damaged();
        String ca = a instanceof String ? ((String) a).trim() : "";
        if (ca.length() > MAX_CA_CHARS) throw damaged();
        if (!ca.isEmpty() && !ca.contains("-----BEGIN CERTIFICATE-----")) throw damaged();

        // 地址只认 HTTPS origin；其余（http、带路径、带凭据）按码损坏处理，不去连接。
        String url;
        try {
            url = CenterPairing.normalizeCenterUrl((String) u);
        } catch (BridgeException invalid) {
            throw damaged();
        }
        return new PairingCode(url, (String) c, ca);
    }

    private static JSONObject decodePayload(String body) throws BridgeException {
        if (!BASE64_URL.matcher(body).matches()) throw damaged();
        try {
            byte[] bytes = Base64.getUrlDecoder().decode(body);
            // 严格 UTF-8：畸形字节不替换成 U+FFFD 后继续解析。
            String json = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
            return new JSONObject(json);
        } catch (IllegalArgumentException | CharacterCodingException | JSONException invalid) {
            throw damaged();
        }
    }

    private static BridgeException damaged() {
        return new BridgeException("INVALID_PAIRING_CODE", "not-sent",
                "配对码不完整或已损坏，请重新复制完整的配对码");
    }

    @Override
    public String toString() {
        return "PairingCode{url=" + url + ", ca=" + (ca.isEmpty() ? "none" : "present") + "}";
    }
}
