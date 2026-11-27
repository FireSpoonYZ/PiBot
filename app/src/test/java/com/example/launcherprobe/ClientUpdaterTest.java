package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Intent;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.Interceptor;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Okio;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class ClientUpdaterTest {

    private Application app;
    private ExecutorService io;

    @Before
    public void setUp() {
        app = RuntimeEnvironment.getApplication();
        io = Executors.newSingleThreadExecutor();
        ClientUpdater.clearHttpClientCacheForTest();
    }

    @After
    public void tearDown() throws Exception {
        ClientUpdater.clearHttpClientCacheForTest();
        io.shutdownNow();
        io.awaitTermination(2, TimeUnit.SECONDS);
    }

    // ---------- OkHttpClient LRU cache & TLS/redirect fences ----------

    @Test
    public void httpClientReusesBlankTrimmedAndIdenticalCaPemAndEnforcesSecurityFlags() throws Exception {
        OkHttpClient nullCa = ClientUpdater.httpClient(null);
        OkHttpClient emptyCa = ClientUpdater.httpClient("");
        OkHttpClient blankCa = ClientUpdater.httpClient("  \n\t  ");
        assertSame(nullCa, emptyCa);
        assertSame(nullCa, blankCa);
        assertFalse(nullCa.followRedirects());
        assertFalse(nullCa.followSslRedirects());
        assertEquals(15_000, nullCa.connectTimeoutMillis());
        assertEquals(60_000, nullCa.readTimeoutMillis());
        assertEquals(30_000, nullCa.writeTimeoutMillis());

        String ca1 = selfSignedTestCertPem("PiBot Test CA 1", 1);
        String ca2 = selfSignedTestCertPem("PiBot Test CA 2", 2);
        OkHttpClient client1 = ClientUpdater.httpClient(ca1);
        OkHttpClient client1Trimmed = ClientUpdater.httpClient("  \n" + ca1.trim() + " \t\n ");
        OkHttpClient client2 = ClientUpdater.httpClient(ca2);

        assertSame(client1, client1Trimmed);
        assertNotSame(nullCa, client1);
        assertNotSame(client1, client2);
        assertFalse(client1.followRedirects());
        assertFalse(client1.followSslRedirects());
        assertFalse(client2.followRedirects());
        assertFalse(client2.followSslRedirects());
        assertEquals(15_000, client1.connectTimeoutMillis());
        assertEquals(60_000, client1.readTimeoutMillis());
        assertEquals(30_000, client1.writeTimeoutMillis());
    }

    @Test
    public void httpClientCacheEvictsLeastRecentlyUsedAndRejectsInvalidCa() throws Exception {
        String ca1 = selfSignedTestCertPem("LRU CA 1", 11);
        String ca2 = selfSignedTestCertPem("LRU CA 2", 12);
        String ca3 = selfSignedTestCertPem("LRU CA 3", 13);
        String ca4 = selfSignedTestCertPem("LRU CA 4", 14);

        OkHttpClient cDefault = ClientUpdater.httpClient("");
        OkHttpClient c1 = ClientUpdater.httpClient(ca1);
        OkHttpClient c2 = ClientUpdater.httpClient(ca2);
        OkHttpClient c3 = ClientUpdater.httpClient(ca3);

        // Invalid CA must throw without evicting cached entries.
        assertThrows(IllegalStateException.class, () -> ClientUpdater.httpClient("not-a-valid-pem"));
        assertThrows(IllegalStateException.class, () -> ClientUpdater.httpClient(
                "-----BEGIN CERTIFICATE-----\nINVALID\n-----END CERTIFICATE-----\n"));

        // Touch default client so c1 becomes the least recently used entry.
        assertSame(cDefault, ClientUpdater.httpClient(null));

        // Adding a 5th distinct CA evicts c1 (LRU) while retaining default, c2, c3, c4.
        OkHttpClient c4 = ClientUpdater.httpClient(ca4);
        assertSame(cDefault, ClientUpdater.httpClient(""));
        assertSame(c2, ClientUpdater.httpClient(ca2));
        assertSame(c3, ClientUpdater.httpClient(ca3));
        assertSame(c4, ClientUpdater.httpClient(ca4));
        assertNotSame(c1, ClientUpdater.httpClient(ca1));
    }

    // ---------- ProgressThrottle ----------

    @Test
    public void progressThrottleSuppressesRapidSmallChunksAndEmitsOnPercentOrInterval() {
        ClientUpdater.ProgressThrottle throttle = new ClientUpdater.ProgressThrottle(1_000L);
        long total = 10_000_000L; // 10 MB; 1% = 100_000 B

        // Rapid small chunks (<120ms and <1%) must not emit.
        assertFalse(throttle.shouldEmit(65_536L, total, 1_010L));
        assertFalse(throttle.shouldEmit(99_999L, total, 1_119L));

        // Advancing percentage by >= 1% emits even when elapsed < 120ms.
        assertTrue(throttle.shouldEmit(100_000L, total, 1_119L));

        // Subsequent small chunk within same percent and <120ms is suppressed.
        assertFalse(throttle.shouldEmit(150_000L, total, 1_200L));
        assertFalse(throttle.shouldEmit(199_999L, total, 1_238L));

        // Elapsed >= 120ms since last emit (1_119 -> 1_239) emits even if percent is still 1%.
        assertTrue(throttle.shouldEmit(199_999L, total, 1_239L));

        // Timer reset on emit: <120ms (119ms) and still 1% is suppressed.
        assertFalse(throttle.shouldEmit(199_999L, total, 1_358L));

        // Advancing to 2% emits immediately even when elapsed < 120ms (1_358 - 1_239 == 119ms).
        assertTrue(throttle.shouldEmit(200_000L, total, 1_358L));

        // Large jump (2% -> 50%) emits once, then 50.5% within 120ms is suppressed.
        assertTrue(throttle.shouldEmit(5_000_000L, total, 1_360L));
        assertFalse(throttle.shouldEmit(5_050_000L, total, 1_400L));

        // Completion (100%) emits, then repeats only after 120ms.
        assertTrue(throttle.shouldEmit(total, total, 1_410L));
        assertFalse(throttle.shouldEmit(total, total, 1_529L));
        assertTrue(throttle.shouldEmit(total, total, 1_530L));
    }

    @Test
    public void progressThrottleHandlesUnknownZeroNegativeAndHugeTotalsSafely() {
        assertEquals(-1, ClientUpdater.ProgressThrottle.progressPercent(65_536L, 0L));
        assertEquals(-1, ClientUpdater.ProgressThrottle.progressPercent(65_536L, -100L));
        assertEquals(0, ClientUpdater.ProgressThrottle.progressPercent(0L, 1_000L));
        assertEquals(0, ClientUpdater.ProgressThrottle.progressPercent(-5L, 1_000L));
        assertEquals(100, ClientUpdater.ProgressThrottle.progressPercent(1_500L, 1_000L));
        assertEquals(50, ClientUpdater.ProgressThrottle.progressPercent(Long.MAX_VALUE / 2L, Long.MAX_VALUE));

        ClientUpdater.ProgressThrottle zeroTotal = new ClientUpdater.ProgressThrottle(500L);
        assertFalse(zeroTotal.shouldEmit(65_536L, 0L, 550L));
        assertFalse(zeroTotal.shouldEmit(131_072L, 0L, 619L));
        assertTrue(zeroTotal.shouldEmit(196_608L, 0L, 620L));
        assertFalse(zeroTotal.shouldEmit(262_144L, 0L, 739L));
        assertTrue(zeroTotal.shouldEmit(327_680L, -1L, 740L));
    }

    // ---------- Broadcast delivery via Robolectric ----------

    @Test
    public void manualCheckUpToDateBroadcastsAfterSettling() throws Exception {
        FakeEnvironment env = new FakeEnvironment();
        env.httpHandler = chain -> emptyResponse(chain.request(), 204, "No Content");
        ClientUpdater updater = new ClientUpdater(app, env, io);

        int before = broadcastCount();
        JSONObject checking = updater.request("updateCheck", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("checking", checking.getString("phase"));
        drainIo();

        List<Intent> broadcasts = statusChangedBroadcastsSince(before);
        assertEquals(1, broadcasts.size());
        assertEquals(app.getPackageName(), broadcasts.get(0).getPackage());

        JSONObject settled = updater.request("updateStatus", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("up-to-date", settled.getString("phase"));
    }

    @Test
    public void manualCheckAvailableAndErrorBroadcastStatusChanged() throws Exception {
        byte[] payload = new byte[1024];
        Arrays.fill(payload, (byte) 0x5a);
        String releaseJson = releaseMetadataJson("1.1.0", 3L, payload);

        FakeEnvironment env = new FakeEnvironment();
        env.httpHandler = chain -> jsonResponse(chain.request(), 200, releaseJson);
        ClientUpdater updater = new ClientUpdater(app, env, io);

        int beforeAvailable = broadcastCount();
        updater.request("updateCheck", new JSONObject()).get(5, TimeUnit.SECONDS);
        drainIo();

        List<Intent> availableBroadcasts = statusChangedBroadcastsSince(beforeAvailable);
        assertEquals(1, availableBroadcasts.size());
        assertEquals(app.getPackageName(), availableBroadcasts.get(0).getPackage());

        JSONObject available = updater.request("updateStatus", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("available", available.getString("phase"));
        JSONObject rel = available.getJSONObject("release");
        assertEquals("1.1.0", rel.getString("version"));
        assertFalse(rel.has("url"));
        assertFalse(rel.has("_generation"));

        // Follow-up manual check encountering HTTP 500 transitions to error and broadcasts.
        env.httpHandler = chain -> emptyResponse(chain.request(), 500, "Server Error");
        int beforeError = broadcastCount();
        updater.request("updateCheck", new JSONObject()).get(5, TimeUnit.SECONDS);
        drainIo();

        List<Intent> errorBroadcasts = statusChangedBroadcastsSince(beforeError);
        assertEquals(1, errorBroadcasts.size());
        assertEquals(app.getPackageName(), errorBroadcasts.get(0).getPackage());

        JSONObject errored = updater.request("updateStatus", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("error", errored.getString("phase"));
        assertFalse(errored.optString("message", "").isEmpty());
    }

    @Test
    public void invalidatedManualCheckAndDownloadBroadcastResetState() throws Exception {
        JSONObject nextGenCreds = credentialsJson(2L);
        FakeEnvironment env = new FakeEnvironment();
        env.httpHandler = chain -> {
            // Simulate center generation switch mid-check before post-HTTP confirmation.
            env.creds.set(nextGenCreds);
            return emptyResponse(chain.request(), 204, "No Content");
        };
        ClientUpdater updater = new ClientUpdater(app, env, io);

        int beforeCheck = broadcastCount();
        JSONObject checking = updater.request("updateCheck", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("checking", checking.getString("phase"));
        drainIo();

        List<Intent> checkBroadcasts = statusChangedBroadcastsSince(beforeCheck);
        assertEquals(1, checkBroadcasts.size());
        assertEquals(app.getPackageName(), checkBroadcasts.get(0).getPackage());

        JSONObject settledCheck = updater.request("updateStatus", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("idle", settledCheck.getString("phase"));

        // Now verify an invalidated download also resets to idle and broadcasts after finish(me).
        byte[] payload = new byte[512];
        Arrays.fill(payload, (byte) 0x22);
        String releaseJson = releaseMetadataJson("1.1.5", 4L, payload);
        JSONObject thirdGenCreds = credentialsJson(3L);
        env.httpHandler = chain -> {
            String path = chain.request().url().encodedPath();
            if (path.startsWith("/api/client-updates/android/")) {
                return jsonResponse(chain.request(), 200, releaseJson);
            }
            env.creds.set(thirdGenCreds);
            return emptyResponse(chain.request(), 500, "Stale");
        };

        updater.request("updateCheck", new JSONObject()).get(5, TimeUnit.SECONDS);
        drainIo();
        assertEquals("available", updater.request("updateStatus", new JSONObject()).get(5, TimeUnit.SECONDS).getString("phase"));

        int beforeDownload = broadcastCount();
        JSONObject downloading = updater.request("updateDownload", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("downloading", downloading.getString("phase"));
        drainIo();

        List<Intent> downloadBroadcasts = statusChangedBroadcastsSince(beforeDownload);
        assertEquals(1, downloadBroadcasts.size());
        assertEquals(app.getPackageName(), downloadBroadcasts.get(0).getPackage());

        JSONObject settledDownload = updater.request("updateStatus", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("idle", settledDownload.getString("phase"));
    }

    @Test
    public void downloadThrottlesProgressBroadcastsAndBroadcastsOnCompletionAndError() throws Exception {
        byte[] payload = new byte[10_000];
        for (int i = 0; i < payload.length; i++) payload[i] = (byte) (i & 0xff);
        String releaseJson = releaseMetadataJson("1.2.0", 4L, payload);

        // 9 chunks summing to 10_000 bytes (each <= 5000 < Okio 8KB segment):
        // 40 (0%, 10ms) -> skip
        // 40 (0%, 20ms) -> skip
        // 40 (1%, 30ms) -> emit #1 (1% advance)
        // 40 (1%, 40ms) -> skip
        // 30 (1%, 150ms) -> emit #2 (120ms elapsed)
        // 40 (2%, 160ms) -> emit #3 (2% advance)
        // 40 (2%, 170ms) -> skip
        // 5000 (52%, 180ms) -> emit #4 (52% advance)
        // 4730 (100%, 190ms) -> emit #5 (100% advance)
        // + terminal downloaded in finally -> emit #6
        int[] chunkSizes = {40, 40, 40, 40, 30, 40, 40, 5_000, 4_730};
        long[] chunkTimes = {10L, 20L, 30L, 40L, 150L, 160L, 170L, 180L, 190L};

        FakeEnvironment env = new FakeEnvironment();
        env.httpHandler = chain -> {
            String path = chain.request().url().encodedPath();
            if (path.startsWith("/api/client-updates/android/")) {
                return jsonResponse(chain.request(), 200, releaseJson);
            }
            ChunkedClockInputStream stream = new ChunkedClockInputStream(payload, chunkSizes, chunkTimes, env.clockMs);
            ResponseBody body = ResponseBody.create(
                    MediaType.parse("application/vnd.android.package-archive"),
                    payload.length,
                    Okio.buffer(Okio.source(stream)));
            return new Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(body)
                    .build();
        };
        ClientUpdater updater = new ClientUpdater(app, env, io);

        updater.request("updateCheck", new JSONObject()).get(5, TimeUnit.SECONDS);
        drainIo();

        env.clockMs.set(0L);
        int beforeDownload = broadcastCount();
        JSONObject started = updater.request("updateDownload", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("downloading", started.getString("phase"));
        drainIo();

        List<Intent> downloadBroadcasts = statusChangedBroadcastsSince(beforeDownload);
        assertEquals(6, downloadBroadcasts.size());
        for (Intent intent : downloadBroadcasts) {
            assertEquals(app.getPackageName(), intent.getPackage());
        }

        JSONObject downloaded = updater.request("updateStatus", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("downloaded", downloaded.getString("phase"));
        assertEquals(10_000L, downloaded.getLong("downloadedBytes"));
        assertEquals(10_000L, downloaded.getLong("totalBytes"));

        // Verify download failure also broadcasts terminal error transition.
        env.httpHandler = chain -> {
            String path = chain.request().url().encodedPath();
            if (path.startsWith("/api/client-updates/android/")) {
                return jsonResponse(chain.request(), 200, releaseJson);
            }
            return emptyResponse(chain.request(), 503, "Unavailable");
        };
        updater.request("updateCheck", new JSONObject()).get(5, TimeUnit.SECONDS);
        drainIo();

        int beforeFailedDownload = broadcastCount();
        updater.request("updateDownload", new JSONObject()).get(5, TimeUnit.SECONDS);
        drainIo();

        List<Intent> failedBroadcasts = statusChangedBroadcastsSince(beforeFailedDownload);
        assertEquals(1, failedBroadcasts.size());
        assertEquals(app.getPackageName(), failedBroadcasts.get(0).getPackage());
        assertEquals("error", updater.request("updateStatus", new JSONObject()).get(5, TimeUnit.SECONDS).getString("phase"));
    }

    @Test
    public void cancelActiveCheckAndInstallerCancelBothBroadcastStatusChanged() throws Exception {
        CountDownLatch httpEntered = new CountDownLatch(1);
        CountDownLatch releaseHttp = new CountDownLatch(1);

        FakeEnvironment env = new FakeEnvironment();
        env.httpHandler = chain -> {
            httpEntered.countDown();
            try {
                releaseHttp.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            throw new IOException("cancelled");
        };
        ClientUpdater updater = new ClientUpdater(app, env, io);

        updater.request("updateCheck", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertTrue(httpEntered.await(5, TimeUnit.SECONDS));

        int beforeCancel = broadcastCount();
        JSONObject cancelled = updater.request("updateCancel", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("cancelled", cancelled.getString("phase"));

        List<Intent> cancelBroadcasts = statusChangedBroadcastsSince(beforeCancel);
        assertEquals(1, cancelBroadcasts.size());
        assertEquals(app.getPackageName(), cancelBroadcasts.get(0).getPackage());

        releaseHttp.countDown();
        drainIo();
        assertEquals(1, statusChangedBroadcastsSince(beforeCancel).size());
        assertEquals("cancelled", updater.request("updateStatus", new JSONObject()).get(5, TimeUnit.SECONDS).getString("phase"));

        // Install -> waiting-permission -> updateCancel delegates to installer and broadcasts transition.
        byte[] payload = new byte[512];
        Arrays.fill(payload, (byte) 0x33);
        String releaseJson = releaseMetadataJson("1.3.0", 5L, payload);
        env.httpHandler = chain -> {
            String path = chain.request().url().encodedPath();
            if (path.startsWith("/api/client-updates/android/")) {
                return jsonResponse(chain.request(), 200, releaseJson);
            }
            return new Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(ResponseBody.create(MediaType.parse("application/vnd.android.package-archive"), payload))
                    .build();
        };
        env.installerInstallResult.set(new JSONObject()
                .put("phase", "waiting-permission")
                .put("message", "请允许此应用安装未知应用"));
        env.installerCancelResult.set(new JSONObject().put("phase", "cancelled"));

        updater.request("updateCheck", new JSONObject()).get(5, TimeUnit.SECONDS);
        drainIo();
        updater.request("updateDownload", new JSONObject()).get(5, TimeUnit.SECONDS);
        drainIo();

        int beforeInstall = broadcastCount();
        JSONObject installRes = updater.request("updateInstall", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("waiting-permission", installRes.getString("phase"));
        List<Intent> installBroadcasts = statusChangedBroadcastsSince(beforeInstall);
        assertEquals(1, installBroadcasts.size());
        assertEquals(app.getPackageName(), installBroadcasts.get(0).getPackage());

        int beforeInstallerCancel = broadcastCount();
        JSONObject installerCancelRes = updater.request("updateCancel", new JSONObject()).get(5, TimeUnit.SECONDS);
        assertEquals("cancelled", installerCancelRes.getString("phase"));
        List<Intent> installerCancelBroadcasts = statusChangedBroadcastsSince(beforeInstallerCancel);
        assertEquals(1, installerCancelBroadcasts.size());
        assertEquals(app.getPackageName(), installerCancelBroadcasts.get(0).getPackage());
    }

    // ---------- Test helpers ----------

    private int broadcastCount() {
        return shadowOf(app).getBroadcastIntents().size();
    }

    private List<Intent> statusChangedBroadcastsSince(int startIndex) {
        List<Intent> all = shadowOf(app).getBroadcastIntents();
        List<Intent> matched = new ArrayList<>();
        for (int i = startIndex; i < all.size(); i++) {
            Intent intent = all.get(i);
            if (ClientUpdateNotifications.ACTION_STATUS_CHANGED.equals(intent.getAction())) {
                matched.add(intent);
            }
        }
        return matched;
    }

    private void drainIo() throws Exception {
        io.submit(() -> { }).get(5, TimeUnit.SECONDS);
    }

    private static JSONObject credentialsJson(long generation) throws Exception {
        return new JSONObject()
                .put("url", "https://center.example.test")
                .put("deviceId", "dev-1")
                .put("deviceToken", "tok-secret")
                .put("ca", "")
                .put("generation", generation);
    }

    private static String releaseMetadataJson(String version, long versionCode, byte[] payload) throws Exception {
        return new JSONObject()
                .put("id", "rel-" + versionCode)
                .put("version", version)
                .put("versionCode", versionCode)
                .put("size", payload.length)
                .put("sha256", sha256Hex(payload))
                .put("platform", "android")
                .put("arch", "aarch64")
                .put("format", "apk")
                .put("url", "/api/client-updates/artifacts/app-" + versionCode + ".apk")
                .put("notes", "Release notes for " + version)
                .toString();
    }

    private static String sha256Hex(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder out = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            out.append(Character.forDigit((b >> 4) & 0xf, 16))
                    .append(Character.forDigit(b & 0xf, 16));
        }
        return out.toString();
    }

    private static Response emptyResponse(Request request, int code, String message) {
        return new Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(code)
                .message(message)
                .body(ResponseBody.create((MediaType) null, new byte[0]))
                .build();
    }

    private static Response jsonResponse(Request request, int code, String json) {
        return new Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(code)
                .message("OK")
                .body(ResponseBody.create(MediaType.parse("application/json"), json))
                .build();
    }

    private static final class ChunkedClockInputStream extends InputStream {
        private final byte[] payload;
        private final int[] chunkSizes;
        private final long[] chunkTimes;
        private final AtomicLong clockMs;
        private int chunkIndex;
        private int chunkOffset;
        private int totalRead;

        ChunkedClockInputStream(byte[] payload, int[] chunkSizes, long[] chunkTimes, AtomicLong clockMs) {
            this.payload = payload;
            this.chunkSizes = chunkSizes;
            this.chunkTimes = chunkTimes;
            this.clockMs = clockMs;
        }

        @Override
        public int read() {
            byte[] single = new byte[1];
            int count = read(single, 0, 1);
            return count == -1 ? -1 : (single[0] & 0xff);
        }

        @Override
        public int read(byte[] b, int off, int len) {
            if (chunkIndex >= chunkSizes.length) return -1;
            int remaining = chunkSizes[chunkIndex] - chunkOffset;
            int toCopy = Math.min(len, remaining);
            System.arraycopy(payload, totalRead, b, off, toCopy);
            totalRead += toCopy;
            chunkOffset += toCopy;
            if (chunkOffset == chunkSizes[chunkIndex]) {
                clockMs.set(chunkTimes[chunkIndex]);
                chunkIndex++;
                chunkOffset = 0;
            }
            return toCopy;
        }
    }

    private static final class FakeEnvironment implements ClientUpdater.Environment {
        final AtomicReference<JSONObject> creds = new AtomicReference<>();
        final AtomicLong clockMs = new AtomicLong(0L);
        final AtomicReference<JSONObject> installerStatusResult = new AtomicReference<>();
        final AtomicReference<JSONObject> installerInstallResult = new AtomicReference<>();
        final AtomicReference<JSONObject> installerCancelResult = new AtomicReference<>();
        volatile Interceptor httpHandler = chain -> emptyResponse(chain.request(), 204, "No Content");

        FakeEnvironment() throws Exception {
            creds.set(credentialsJson(1L));
        }

        @Override
        public JSONObject updateCredentials() throws Exception {
            JSONObject current = creds.get();
            if (current == null) {
                throw new BridgeException("NOT_CONNECTED", "not-sent", "中心连接未就绪");
            }
            return new JSONObject(current.toString());
        }

        @Override
        public CompletableFuture<JSONObject> confirmUpdateCredentials() {
            try {
                return CompletableFuture.completedFuture(updateCredentials());
            } catch (Exception failure) {
                CompletableFuture<JSONObject> failed = new CompletableFuture<>();
                failed.completeExceptionally(failure);
                return failed;
            }
        }

        @Override
        public OkHttpClient httpClient(String caPem) {
            return new OkHttpClient.Builder()
                    .followRedirects(false)
                    .followSslRedirects(false)
                    .addInterceptor(chain -> httpHandler.intercept(chain))
                    .build();
        }

        @Override
        public long elapsedRealtimeMs() {
            return clockMs.get();
        }

        @Override
        public ClientUpdater.AppIdentity readIdentity() {
            return new ClientUpdater.AppIdentity("1.0.0", 2L, "aarch64");
        }

        @Override
        public void verifyPackage(File apk, JSONObject rel, long currentVersionCode) throws Exception {
            assertNotNull(apk);
            assertTrue(apk.isFile());
            assertEquals(rel.getLong("size"), apk.length());
            assertTrue(rel.getLong("versionCode") > currentVersionCode);
        }

        @Override
        public JSONObject installerStatus() {
            return installerStatusResult.get();
        }

        @Override
        public JSONObject installerInstall(File apk, JSONObject publicRelease) {
            return installerInstallResult.get();
        }

        @Override
        public JSONObject installerCancel() {
            return installerCancelResult.get();
        }
    }

    /** Generates a self-signed X.509 v3 ECDSA P-256 test certificate PEM using standard JDK APIs. */
    private static String selfSignedTestCertPem(String commonName, int serialNumber) throws Exception {
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("EC");
        kpg.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair keyPair = kpg.generateKeyPair();

        // AlgorithmIdentifier: ecdsa-with-SHA256 (OID 1.2.840.10045.4.3.2), parameters omitted per RFC 5758.
        byte[] algId = new byte[] {
                0x30, 0x0a,
                0x06, 0x08, 0x2a, (byte) 0x86, 0x48, (byte) 0xce, 0x3d, 0x04, 0x03, 0x02
        };
        // OID 2.5.4.3 (id-at-commonName).
        byte[] cnOid = new byte[] { 0x06, 0x03, 0x55, 0x04, 0x03 };
        byte[] name = derSeq(derSet(derSeq(cnOid, derTag(0x0c, commonName.getBytes(StandardCharsets.UTF_8)))));
        byte[] validity = derSeq(
                derTag(0x17, "250101000000Z".getBytes(StandardCharsets.US_ASCII)),
                derTag(0x17, "450101000000Z".getBytes(StandardCharsets.US_ASCII)));
        byte[] version = derTag(0xa0, derInt(2)); // v3
        byte[] serial = derInt(serialNumber);
        byte[] spki = keyPair.getPublic().getEncoded();

        byte[] tbs = derSeq(version, serial, algId, name, validity, name, spki);
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(keyPair.getPrivate());
        signer.update(tbs);
        byte[] signatureBytes = signer.sign();

        byte[] certDer = derSeq(tbs, algId, derBitString(signatureBytes));
        String encoded = Base64.getMimeEncoder(64, new byte[] { '\n' }).encodeToString(certDer);
        return "-----BEGIN CERTIFICATE-----\n" + encoded + "\n-----END CERTIFICATE-----\n";
    }

    private static byte[] derTag(int tag, byte[] content) {
        int len = content.length;
        ByteArrayOutputStream out = new ByteArrayOutputStream(len + 6);
        out.write(tag);
        if (len < 128) {
            out.write(len);
        } else if (len < 256) {
            out.write(0x81);
            out.write(len);
        } else if (len < 65536) {
            out.write(0x82);
            out.write((len >> 8) & 0xff);
            out.write(len & 0xff);
        } else {
            throw new IllegalArgumentException("DER length too large: " + len);
        }
        out.write(content, 0, len);
        return out.toByteArray();
    }

    private static byte[] derInt(int value) {
        return derTag(0x02, BigInteger.valueOf(value).toByteArray());
    }

    private static byte[] derBitString(byte[] bytes) {
        byte[] body = new byte[bytes.length + 1];
        body[0] = 0;
        System.arraycopy(bytes, 0, body, 1, bytes.length);
        return derTag(0x03, body);
    }

    private static byte[] derSeq(byte[]... parts) {
        return derTag(0x30, concat(parts));
    }

    private static byte[] derSet(byte[]... parts) {
        return derTag(0x31, concat(parts));
    }

    private static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            out.write(part, 0, part.length);
        }
        return out.toByteArray();
    }
}
