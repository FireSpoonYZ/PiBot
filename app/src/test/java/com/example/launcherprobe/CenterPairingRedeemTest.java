package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import java.io.IOException;
import java.security.cert.CertPathValidatorException;
import java.security.cert.CertificateException;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** 兑换失败与传输失败的归类：用户看到的是“码的问题 / 设备的问题 / 证书问题 / 网络问题”，而不是笼统的失败。 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class CenterPairingRedeemTest {

    private static String body(String code) {
        return "{\"error\":{\"code\":\"" + code + "\",\"message\":\"x\"}}";
    }

    private static String codeOf(int status, String body) {
        BridgeException failure = CenterPairing.redeemFailure(status, body);
        assertEquals("not-sent", failure.outcome);
        return failure.code;
    }

    @Test public void centerRefusalsKeepTheirCodes() {
        assertEquals("PAIRING_CODE_INVALID", codeOf(401, body("PAIRING_CODE_INVALID")));
        assertEquals("PAIRING_CODE_USED", codeOf(409, body("PAIRING_CODE_USED")));
        assertEquals("PAIRING_CODE_EXPIRED", codeOf(410, body("PAIRING_CODE_EXPIRED")));
        assertEquals("DEVICE_ALREADY_REGISTERED", codeOf(409, body("DEVICE_ALREADY_REGISTERED")));
        assertEquals("PAIRING_CODE_DEVICE_MISMATCH", codeOf(409, body("PAIRING_CODE_DEVICE_MISMATCH")));
    }

    @Test public void anAlreadyRegisteredDeviceIsNeverReportedAsALocalBinding() {
        // ALREADY_CONFIGURED makes the UI offer to replace the binding saved on this phone: wrong remedy here.
        String code = codeOf(409, body("DEVICE_ALREADY_REGISTERED"));
        assertFalse("ALREADY_CONFIGURED".equals(code));
        BridgeException failure = CenterPairing.redeemFailure(409, body("DEVICE_ALREADY_REGISTERED"));
        assertTrue(failure.getMessage().contains("重新配对"));
    }

    @Test public void rateLimitingAndOldCentersAreRecognisedByStatus() {
        assertEquals("RATE_LIMITED", codeOf(429, body("RATE_LIMITED")));
        assertEquals("RATE_LIMITED", codeOf(429, ""));
        // A center without pairing codes has no such route: SPA fallback or method not allowed.
        assertEquals("CENTER_UNSUPPORTED", codeOf(404, body("NOT_FOUND")));
        assertEquals("CENTER_UNSUPPORTED", codeOf(405, ""));
    }

    @Test public void anythingElseIsAGenericCenterErrorNeverAnOwnerPasswordProblem() {
        assertEquals("CENTER_ERROR", codeOf(401, ""));
        assertEquals("CENTER_ERROR", codeOf(500, body("INTERNAL_ERROR")));
        assertEquals("CENTER_ERROR", codeOf(502, "<html>bad gateway</html>"));
        assertTrue(CenterPairing.redeemFailure(500, "").getMessage().contains("500"));
    }

    @Test public void errorCodeIsReadFromTheCentersErrorEnvelopeOnly() {
        assertEquals("PAIRING_CODE_USED", CenterPairing.errorCodeOf(body("PAIRING_CODE_USED")));
        assertNull(CenterPairing.errorCodeOf(null));
        assertNull(CenterPairing.errorCodeOf(""));
        assertNull(CenterPairing.errorCodeOf("not json"));
        assertNull(CenterPairing.errorCodeOf("{\"code\":\"PAIRING_CODE_USED\"}"));
        assertNull(CenterPairing.errorCodeOf("{\"error\":\"PAIRING_CODE_USED\"}"));
        assertNull(CenterPairing.errorCodeOf("{\"error\":{\"message\":\"x\"}}"));
    }

    @Test public void anExpiredCertificateIsACertificateFailureToo() {
        // No CertPathValidatorException in the chain: the certificate exception alone must be enough.
        Throwable expired = new SSLHandshakeException("NotAfter: Mon Jan 01 00:00:00 UTC 2024");
        expired.initCause(new java.security.cert.CertificateExpiredException("expired"));
        assertTrue(CenterPairing.isCertificateFailure(expired));
        assertEquals("CENTER_CERT_UNTRUSTED", CenterPairing.transportFailure(expired).code);
    }

    @Test public void certificateFailuresAreToldApartFromNetworkOnes() {
        // What Android's TLS stack throws for a chain that does not end in a trusted root.
        Throwable untrusted = new SSLHandshakeException("Trust anchor for certification path not found.");
        untrusted.initCause(new CertificateException(new CertPathValidatorException("Trust anchor")));
        assertTrue(CenterPairing.isCertificateFailure(untrusted));
        assertEquals("CENTER_CERT_UNTRUSTED", CenterPairing.transportFailure(untrusted).code);

        assertTrue(CenterPairing.isCertificateFailure(new SSLPeerUnverifiedException("Hostname 10.0.0.1 not verified")));
        assertEquals("CENTER_CERT_UNTRUSTED",
                CenterPairing.transportFailure(new RuntimeException(new SSLPeerUnverifiedException("host"))).code);

        assertFalse(CenterPairing.isCertificateFailure(new IOException("Connection refused")));
        assertFalse(CenterPairing.isCertificateFailure(new java.net.SocketTimeoutException("timeout")));
        // A handshake that died for a non-certificate reason is a connectivity problem.
        assertFalse(CenterPairing.isCertificateFailure(new SSLHandshakeException("Connection closed by peer")));
        assertEquals("CENTER_UNREACHABLE", CenterPairing.transportFailure(new IOException("refused")).code);
        assertFalse(CenterPairing.isCertificateFailure(null));
    }

    @Test public void aCauseLoopCannotHangTheClassifier() {
        IOException loop = new IOException("a") {
            @Override public synchronized Throwable getCause() {
                return this;
            }
        };
        assertFalse(CenterPairing.isCertificateFailure(loop));
        Throwable a = new IOException("a");
        Throwable b = new IOException("b", a);
        a.initCause(b);
        assertFalse(CenterPairing.isCertificateFailure(a));
    }

    @Test public void theCertificateMessageSaysWhatToDo() {
        String message = CenterPairing.transportFailure(new SSLPeerUnverifiedException("x")).getMessage();
        assertTrue(message.contains("私有 CA"));
        assertTrue(message.contains("重新生成配对码"));
    }
}
