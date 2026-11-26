package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;
import static org.robolectric.Shadows.shadowOf;

import android.Manifest;
import android.app.Application;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowNotificationManager;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Delayed;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class ClientUpdaterAutoTriggerTest {

    private Application app;
    private ShadowNotificationManager notifications;
    private ExecutorService io;
    private ManualScheduler pushScheduler;
    private AtomicLong clockMs;
    private AtomicLong jitterMs;
    private AtomicBoolean serviceActive;
    private AtomicReference<JSONObject> credsRef;
    private AtomicReference<ClientUpdater.AppIdentity> identityRef;
    private AtomicReference<ClientUpdater.CheckFetcher> fetcherRef;
    private AtomicInteger fetchCount;

    private static final class ScheduledEntry implements ScheduledFuture<Object> {
        final Runnable command;
        final long delayMs;
        private volatile boolean cancelled;
        private volatile boolean done;

        ScheduledEntry(Runnable command, long delayMs) {
            this.command = command;
            this.delayMs = delayMs;
        }

        void run() {
            if (cancelled || done) return;
            done = true;
            command.run();
        }

        @Override public long getDelay(TimeUnit unit) {
            return unit.convert(delayMs, TimeUnit.MILLISECONDS);
        }

        @Override public int compareTo(Delayed other) {
            return Long.compare(getDelay(TimeUnit.MILLISECONDS), other.getDelay(TimeUnit.MILLISECONDS));
        }

        @Override public boolean cancel(boolean mayInterruptIfRunning) {
            if (done) return false;
            cancelled = true;
            done = true;
            return true;
        }

        @Override public boolean isCancelled() {
            return cancelled;
        }

        @Override public boolean isDone() {
            return done;
        }

        @Override public Object get() throws InterruptedException, ExecutionException {
            return null;
        }

        @Override public Object get(long timeout, TimeUnit unit)
                throws InterruptedException, ExecutionException, TimeoutException {
            return null;
        }
    }

    private static final class ManualScheduler extends AbstractExecutorService implements ScheduledExecutorService {
        private final List<ScheduledEntry> scheduled = new ArrayList<>();
        private volatile boolean shutdown;

        synchronized int scheduledCount() {
            return scheduled.size();
        }

        synchronized ScheduledEntry lastEntry() {
            return scheduled.isEmpty() ? null : scheduled.get(scheduled.size() - 1);
        }

        void runAllPending() {
            List<ScheduledEntry> copy;
            synchronized (this) {
                copy = new ArrayList<>(scheduled);
            }
            for (ScheduledEntry entry : copy) {
                if (!entry.isDone() && !entry.isCancelled()) {
                    entry.run();
                }
            }
        }

        @Override public synchronized ScheduledFuture<?> schedule(Runnable command, long delay, TimeUnit unit) {
            ScheduledEntry entry = new ScheduledEntry(command, unit.toMillis(delay));
            scheduled.add(entry);
            return entry;
        }

        @Override public <V> ScheduledFuture<V> schedule(Callable<V> callable, long delay, TimeUnit unit) {
            throw new UnsupportedOperationException();
        }

        @Override public ScheduledFuture<?> scheduleAtFixedRate(Runnable command, long initialDelay, long period, TimeUnit unit) {
            throw new UnsupportedOperationException();
        }

        @Override public ScheduledFuture<?> scheduleWithFixedDelay(Runnable command, long initialDelay, long delay, TimeUnit unit) {
            throw new UnsupportedOperationException();
        }

        @Override public void shutdown() {
            shutdown = true;
        }

        @Override public List<Runnable> shutdownNow() {
            shutdown = true;
            return new ArrayList<>();
        }

        @Override public boolean isShutdown() {
            return shutdown;
        }

        @Override public boolean isTerminated() {
            return shutdown;
        }

        @Override public boolean awaitTermination(long timeout, TimeUnit unit) {
            return shutdown;
        }

        @Override public void execute(Runnable command) {
            schedule(command, 0L, TimeUnit.MILLISECONDS);
        }
    }

    private interface ThrowingAction {
        void run() throws Exception;
    }

    @Before
    public void setUp() throws Exception {
        app = RuntimeEnvironment.getApplication();
        notifications = shadowOf(app.getSystemService(NotificationManager.class));
        app.getSharedPreferences("client_update", Context.MODE_PRIVATE).edit().clear().commit();
        app.getSharedPreferences("client_update_notifications", Context.MODE_PRIVATE).edit().clear().commit();
        app.getSharedPreferences("client_update_installer", Context.MODE_PRIVATE).edit().clear().commit();
        shadowOf(app).clearBroadcastIntents();
        ClientUpdateNotifications.cancel(app);

        io = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "test-client-update-io");
            thread.setDaemon(true);
            return thread;
        });
        pushScheduler = new ManualScheduler();
        clockMs = new AtomicLong(1_000_000L);
        jitterMs = new AtomicLong(0L);
        serviceActive = new AtomicBoolean(true);
        credsRef = new AtomicReference<>(creds("https://center-a.example.com", "dev-1", 1L));
        identityRef = new AtomicReference<>(new ClientUpdater.AppIdentity("1.0.1", 1L, "aarch64"));
        fetchCount = new AtomicInteger();
        fetcherRef = new AtomicReference<>((me, creds, endpoint, arch, currentVersionCode) -> {
            fetchCount.incrementAndGet();
            return null; // 204 up-to-date by default
        });
    }

    @After
    public void tearDown() throws Exception {
        io.shutdownNow();
        io.awaitTermination(2, TimeUnit.SECONDS);
        pushScheduler.shutdownNow();
    }

    private ClientUpdater newUpdater() {
        ClientUpdater.CredentialsProvider provider = new ClientUpdater.CredentialsProvider() {
            @Override public JSONObject current() throws Exception {
                JSONObject creds = credsRef.get();
                if (creds == null) {
                    throw new BridgeException("NOT_CONNECTED", "not-sent", "中心连接未就绪");
                }
                return new JSONObject(creds.toString());
            }

            @Override public CompletableFuture<JSONObject> confirm() {
                JSONObject creds = credsRef.get();
                if (creds == null) {
                    CompletableFuture<JSONObject> failed = new CompletableFuture<>();
                    failed.completeExceptionally(new BridgeException("NOT_CONNECTED", "not-sent", "中心连接未就绪"));
                    return failed;
                }
                try {
                    return CompletableFuture.completedFuture(new JSONObject(creds.toString()));
                } catch (Exception failure) {
                    CompletableFuture<JSONObject> failed = new CompletableFuture<>();
                    failed.completeExceptionally(failure);
                    return failed;
                }
            }
        };
        return new ClientUpdater(
                app,
                io,
                pushScheduler,
                clockMs::get,
                jitterMs::get,
                serviceActive::get,
                provider,
                (me, creds, endpoint, arch, currentVersionCode) ->
                        fetcherRef.get().fetch(me, creds, endpoint, arch, currentVersionCode),
                identityRef::get);
    }

    private void drainIo() throws Exception {
        io.submit(() -> {}).get(2, TimeUnit.SECONDS);
        io.submit(() -> {}).get(2, TimeUnit.SECONDS);
    }

    private JSONObject status(ClientUpdater updater) throws Exception {
        return updater.request("updateStatus", new JSONObject()).get(2, TimeUnit.SECONDS);
    }

    private static JSONObject creds(String url, String deviceId, long generation) throws Exception {
        return new JSONObject()
                .put("url", url)
                .put("deviceId", deviceId)
                .put("deviceToken", "secret-token-" + generation)
                .put("ca", "")
                .put("generation", generation);
    }

    private static JSONObject release(long versionCode) throws Exception {
        return new JSONObject()
                .put("id", "rel-" + versionCode)
                .put("version", "1.0." + versionCode)
                .put("versionCode", versionCode)
                .put("size", 1024L * versionCode)
                .put("sha256", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
                .put("notes", "Notes for " + versionCode)
                .put("sourceCommit", "abcdef0123456789abcdef0123456789abcdef01")
                .put("url", "/api/client-updates/android/aarch64/apk/rel-" + versionCode);
    }

    private static BridgeException expectInvalidArg(ThrowingAction action) {
        try {
            action.run();
            fail("expected INVALID_ARGUMENT BridgeException");
            return null;
        } catch (AssertionError assertion) {
            throw assertion;
        } catch (Throwable failure) {
            Throwable cause = failure;
            while ((cause instanceof CompletionException || cause instanceof ExecutionException)
                    && cause.getCause() != null) {
                cause = cause.getCause();
            }
            assertTrue("expected BridgeException, got " + cause, cause instanceof BridgeException);
            BridgeException bridge = (BridgeException) cause;
            assertEquals("INVALID_ARGUMENT", bridge.code);
            assertEquals("not-sent", bridge.outcome);
            return bridge;
        }
    }

    private static String sha256Hex(String text) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        }
        return out.toString();
    }

    // ---------- 1. updateCheck 参数白名单校验 ----------

    @Test
    public void updateCheckParamValidationAcceptsWhitelistAndRejectsInvalidOrUnknownParams() throws Exception {
        // Valid forms pass both BotHostUiBridgeService and ClientUpdater.parseCheckParams.
        BotHostUiBridgeService.validateUpdateCheckParams(null);
        BotHostUiBridgeService.validateUpdateCheckParams(new JSONObject());
        BotHostUiBridgeService.validateUpdateCheckParams(new JSONObject().put("automatic", true));
        BotHostUiBridgeService.validateUpdateCheckParams(new JSONObject().put("automatic", false));
        String[] reasons = {
                ClientUpdater.REASON_STARTUP,
                ClientUpdater.REASON_FOREGROUND,
                ClientUpdater.REASON_UPDATES_PAGE,
                ClientUpdater.REASON_PUSH,
                ClientUpdater.REASON_PERIODIC
        };
        for (String reason : reasons) {
            JSONObject autoParams = new JSONObject().put("automatic", true).put("reason", reason);
            BotHostUiBridgeService.validateUpdateCheckParams(autoParams);
            ClientUpdater.CheckParams parsedAuto = ClientUpdater.parseCheckParams(autoParams);
            assertTrue(parsedAuto.automatic);
            assertEquals(reason, parsedAuto.reason);

            JSONObject manualParams = new JSONObject().put("automatic", false).put("reason", reason);
            BotHostUiBridgeService.validateUpdateCheckParams(manualParams);
            ClientUpdater.CheckParams parsedManual = ClientUpdater.parseCheckParams(manualParams);
            assertFalse(parsedManual.automatic);
            assertEquals(reason, parsedManual.reason);

            JSONObject reasonOnly = new JSONObject().put("reason", reason);
            BotHostUiBridgeService.validateUpdateCheckParams(reasonOnly);
            ClientUpdater.CheckParams parsedOnly = ClientUpdater.parseCheckParams(reasonOnly);
            assertFalse(parsedOnly.automatic);
            assertEquals(reason, parsedOnly.reason);
        }

        // Invalid reasons, wrong types, null/empty, unknown keys MUST be rejected with INVALID_ARGUMENT
        // (including when automatic == false).
        ClientUpdater updater = newUpdater();
        JSONObject[] invalidCases = {
                new JSONObject().put("reason", JSONObject.NULL),
                new JSONObject().put("reason", ""),
                new JSONObject().put("reason", "unknown"),
                new JSONObject().put("reason", "STARTUP"),
                new JSONObject().put("reason", " startup "),
                new JSONObject().put("reason", "manual"),
                new JSONObject().put("reason", 123),
                new JSONObject().put("reason", true),
                new JSONObject().put("reason", new JSONObject()),
                new JSONObject().put("reason", new JSONArray()),
                new JSONObject().put("automatic", false).put("reason", "bad"),
                new JSONObject().put("automatic", false).put("reason", ""),
                new JSONObject().put("automatic", false).put("reason", JSONObject.NULL),
                new JSONObject().put("automatic", "true"),
                new JSONObject().put("automatic", JSONObject.NULL),
                new JSONObject().put("automatic", true).put("reason", "startup").put("extra", "nope"),
                new JSONObject().put("url", "https://evil.example.com/a.apk"),
                new JSONObject().put("stopActive", true)
        };
        for (JSONObject invalid : invalidCases) {
            expectInvalidArg(() -> BotHostUiBridgeService.validateUpdateCheckParams(invalid));
            expectInvalidArg(() -> updater.request("updateCheck", invalid).get(2, TimeUnit.SECONDS));
        }
        assertEquals(0, fetchCount.get());
    }

    // ---------- 2. 5 级冷却策略、切换中心/重连/版本升级穿透、手动穿透并刷新时间戳 ----------

    @Test
    public void tieredCooldownThresholdsAndDefaultAutomaticPeriodicBehavior() throws Exception {
        assertEquals(0L, ClientUpdater.cooldownForReason("push"));
        assertEquals(30_000L, ClientUpdater.cooldownForReason("updates-page"));
        assertEquals(120_000L, ClientUpdater.cooldownForReason("startup"));
        assertEquals(600_000L, ClientUpdater.cooldownForReason("foreground"));
        assertEquals(4L * 60L * 60L * 1000L, ClientUpdater.cooldownForReason("periodic"));

        ClientUpdater updater = newUpdater();
        // Start monotonic clock at 0L to prove cooldown works even at epoch 0.
        clockMs.set(0L);

        // Initial check runs immediately (no prior check).
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "startup"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(1, fetchCount.get());
        assertEquals("up-to-date", status(updater).getString("phase"));

        // updates-page: 29_999ms skipped, 30_000ms runs.
        clockMs.set(29_999L);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "updates-page"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(1, fetchCount.get());

        clockMs.set(30_000L);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "updates-page"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(2, fetchCount.get());

        // startup: 119_999ms after t=30_000 (149_999) skipped, 120_000ms (150_000) runs.
        clockMs.set(149_999L);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "startup"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(2, fetchCount.get());

        clockMs.set(150_000L);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "startup"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(3, fetchCount.get());

        // foreground: 599_999ms after t=150_000 (749_999) skipped, 600_000ms (750_000) runs.
        clockMs.set(749_999L);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "foreground"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(3, fetchCount.get());

        clockMs.set(750_000L);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "foreground"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(4, fetchCount.get());

        // periodic & omitted reason (automatic=true): 4h - 1ms skipped, 4h runs.
        long fourHours = 4L * 60L * 60L * 1000L;
        clockMs.set(750_000L + fourHours - 1L);
        updater.request("updateCheck", new JSONObject().put("automatic", true))
                .get(2, TimeUnit.SECONDS);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "periodic"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(4, fetchCount.get());

        clockMs.set(750_000L + fourHours);
        updater.request("updateCheck", new JSONObject().put("automatic", true))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(5, fetchCount.get());

        // push: 0ms cooldown -> runs immediately even at the exact same timestamp!
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "push"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(6, fetchCount.get());
    }

    @Test
    public void manualCheckBypassesCooldownAndRefreshesTimestampAndScopeChangesResetCooldown() throws Exception {
        ClientUpdater updater = newUpdater();
        clockMs.set(100_000L);

        // Initial automatic check completes at t=100_000.
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "startup"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(1, fetchCount.get());

        // Manual check at t=120_000 (20s later) bypasses cooldown unconditionally AND refreshes lastCheckAtElapsed!
        clockMs.set(120_000L);
        updater.request("updateCheck", new JSONObject().put("automatic", false))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(2, fetchCount.get());

        // Even with a valid reason supplied on manual check, automatic=false still bypasses cooldown.
        clockMs.set(125_000L);
        updater.request("updateCheck", new JSONObject().put("automatic", false).put("reason", "periodic"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(3, fetchCount.get());

        // Automatic updates-page check 29_999ms after manual check (t=154_999) is throttled by refreshed timestamp!
        clockMs.set(154_999L);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "updates-page"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(3, fetchCount.get());

        // 1) Reconnect (generation increments 1 -> 2): resets and bypasses cooldown immediately!
        credsRef.set(creds("https://center-a.example.com", "dev-1", 2L));
        clockMs.set(155_000L);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "periodic"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(4, fetchCount.get());

        // 2) Switch Center (origin changes): resets and bypasses cooldown immediately!
        credsRef.set(creds("https://center-b.example.com", "dev-1", 3L));
        clockMs.set(155_100L);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "periodic"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(5, fetchCount.get());

        // 3) Device ID changes (even with same generation): scopeKey changes -> resets and bypasses cooldown!
        credsRef.set(creds("https://center-b.example.com", "dev-2", 3L));
        clockMs.set(155_200L);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "periodic"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(6, fetchCount.get());

        // 4) Installed versionCode changes (new version installed): scopeKey changes -> resets and bypasses cooldown!
        identityRef.set(new ClientUpdater.AppIdentity("1.0.2", 2L, "aarch64"));
        clockMs.set(155_300L);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "periodic"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(7, fetchCount.get());
    }

    // ---------- 3. 移除 24 小时 SharedPreferences 持久化锁死 ----------

    @Test
    public void legacy24hSharedPreferencesLockIsRemovedAndNeverWritten() throws Exception {
        SharedPreferences prefs = app.getSharedPreferences("client_update", Context.MODE_PRIVATE);
        String legacyKey = "up-to-date:" + sha256Hex("https://center-a.example.com|dev-1") + ":1";
        prefs.edit().putLong(legacyKey, System.currentTimeMillis()).commit();

        ClientUpdater firstInstance = newUpdater();
        firstInstance.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "startup"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals("legacy 24h up-to-date disk key must not block automatic check", 1, fetchCount.get());
        assertEquals("up-to-date", status(firstInstance).getString("phase"));

        // Clear legacy key, run another 204 check, and assert no up-to-date:* key is ever written to disk.
        prefs.edit().clear().commit();
        clockMs.addAndGet(ClientUpdater.COOLDOWN_STARTUP_MS);
        firstInstance.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "startup"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(2, fetchCount.get());
        for (String key : prefs.getAll().keySet()) {
            assertFalse("must not persist up-to-date lock key: " + key, key.startsWith("up-to-date:"));
        }

        // A new ClientUpdater instance (simulating process restart) immediately checks without a 24h lock!
        ClientUpdater restartedInstance = newUpdater();
        restartedInstance.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "startup"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(3, fetchCount.get());
    }

    // ---------- 4. onReleasePublished 抖动合并、后台推送通知与 BotHostProcess/BotHostClient 转发 ----------

    @Test
    public void onReleasePublishedAppliesJitterCoalescesBurstsNotifiesAndBroadcastsInBackground() throws Exception {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
        ClientUpdater updater = newUpdater();

        // First check returns 204 so we are inside all non-push cooldown windows.
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "startup"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(1, fetchCount.get());
        assertEquals("up-to-date", status(updater).getString("phase"));

        // Server publishes v2; push arrives with injected jitter = 1234ms.
        fetcherRef.set((me, creds, endpoint, arch, currentVersionCode) -> {
            fetchCount.incrementAndGet();
            return release(2L);
        });
        jitterMs.set(1234L);
        shadowOf(app).clearBroadcastIntents();

        // Burst of 3 pushes while first jitter task is pending -> coalesced into 1 scheduled task.
        updater.onReleasePublished();
        updater.onReleasePublished();
        updater.onReleasePublished();
        assertEquals(1, pushScheduler.scheduledCount());
        assertEquals(1234L, pushScheduler.lastEntry().delayMs);

        // Execute jittered push -> bypasses cooldown (0ms), discovers v2, notifies & broadcasts!
        pushScheduler.runAllPending();
        drainIo();
        assertEquals(2, fetchCount.get());
        JSONObject snap = status(updater);
        assertEquals("available", snap.getString("phase"));
        JSONObject publicRel = snap.getJSONObject("release");
        assertEquals(2L, publicRel.getLong("versionCode"));
        // Security check: never expose internal artifact URL or credentials/fence fields.
        assertFalse(publicRel.has("url"));
        assertFalse(publicRel.has("_origin"));
        assertFalse(publicRel.has("_deviceId"));
        assertFalse(publicRel.has("_generation"));
        assertFalse(snap.toString().contains("secret-token"));
        assertEquals(1, notifications.getAllNotifications().size());
        boolean sawBroadcast = false;
        for (Intent intent : shadowOf(app).getBroadcastIntents()) {
            if (ClientUpdateNotifications.ACTION_STATUS_CHANGED.equals(intent.getAction())) {
                sawBroadcast = true;
                break;
            }
        }
        assertTrue("expected statusChanged broadcast for UI sync", sawBroadcast);

        // Another push returning the same v2 MUST NOT post a duplicate system notification.
        ClientUpdateNotifications.cancel(app);
        jitterMs.set(0L);
        updater.onReleasePublished();
        assertEquals(2, pushScheduler.scheduledCount());
        assertEquals(0L, pushScheduler.lastEntry().delayMs);
        pushScheduler.runAllPending();
        drainIo();
        assertEquals(3, fetchCount.get());
        assertTrue("same version must not re-notify", notifications.getAllNotifications().isEmpty());

        // Newer release v3 published -> push notifies again!
        fetcherRef.set((me, creds, endpoint, arch, currentVersionCode) -> {
            fetchCount.incrementAndGet();
            return release(3L);
        });
        updater.onReleasePublished();
        pushScheduler.runAllPending();
        drainIo();
        assertEquals(4, fetchCount.get());
        assertEquals(1, notifications.getAllNotifications().size());
        assertEquals(3L, status(updater).getJSONObject("release").getLong("versionCode"));

        // Over-range jitter is clamped to [0, 3000], and cancelPendingPush prevents execution.
        jitterMs.set(99_999L);
        updater.onReleasePublished();
        assertEquals(ClientUpdater.PUSH_JITTER_MAX_MS, pushScheduler.lastEntry().delayMs);
        updater.cancelPendingPush();
        pushScheduler.runAllPending();
        drainIo();
        assertEquals(4, fetchCount.get());

        // Inactive service ignores onReleasePublished.
        serviceActive.set(false);
        jitterMs.set(0L);
        int beforeInactive = pushScheduler.scheduledCount();
        updater.onReleasePublished();
        assertEquals(beforeInactive, pushScheduler.scheduledCount());
    }

    @Test
    public void botHostProcessParsesCenterEventAndBotHostClientValidatesSessionBeforeTriggering() throws Exception {
        AtomicInteger clientTriggered = new AtomicInteger();
        AtomicBoolean activeFlag = new AtomicBoolean(true);
        BotHostClient hostClient = new BotHostClient(app, activeFlag::get, clientTriggered::incrementAndGet);

        JSONObject clientInit = new JSONObject()
                .put("type", "init")
                .put("protocol", 1)
                .put("mode", "client");
        JSONObject clientReady = new JSONObject()
                .put("type", "ready")
                .put("protocol", 1)
                .put("deviceId", "client-1")
                .put("url", JSONObject.NULL)
                .put("nodeVersion", "v24.0.0")
                .put("platform", "android")
                .put("arch", "arm64");
        JSONObject releaseEvent = new JSONObject()
                .put("type", "center_event")
                .put("event", "client-release-published");

        BotHostProcess process = BotHostProcess.createForTest(app, clientInit, hostClient.processListenerForTest());
        hostClient.setSessionStateForTest(process, true, false, true, false, false, false);

        // Before ready: ignored without closing process.
        process.handleMessageForTest(releaseEvent);
        assertEquals(0, clientTriggered.get());
        assertFalse(process.isClosedForTest());

        // Ready arrives -> valid center_event forwards to BotHostClient -> triggers callback!
        process.handleMessageForTest(clientReady);
        process.handleMessageForTest(releaseEvent);
        assertEquals(1, clientTriggered.get());
        assertFalse(process.isClosedForTest());

        // Unknown / malformed center_event values are silently ignored without terminating process.
        process.handleMessageForTest(new JSONObject().put("type", "center_event").put("event", "config-changed"));
        process.handleMessageForTest(new JSONObject().put("type", "center_event").put("event", ""));
        process.handleMessageForTest(new JSONObject().put("type", "center_event").put("event", JSONObject.NULL));
        process.handleMessageForTest(new JSONObject().put("type", "center_event").put("event", 42));
        process.handleMessageForTest(new JSONObject().put("type", "center_event"));
        assertEquals(1, clientTriggered.get());
        assertFalse(process.isClosedForTest());

        // Existing result / observation frame paths remain unaffected.
        process.handleMessageForTest(new JSONObject().put("type", "result").put("id", "late-id").put("result", new JSONObject()));
        process.handleMessageForTest(new JSONObject()
                .put("type", "frame")
                .put("id", "late-obs")
                .put("frame", new JSONObject().put("type", "event")));
        assertFalse(process.isClosedForTest());

        // Session/generation guards in BotHostClient reject stale/inactive/blocked/pending/closing sessions.
        BotHostProcess staleProcess = BotHostProcess.createForTest(app, clientInit, hostClient.processListenerForTest());
        staleProcess.handleMessageForTest(clientReady);
        staleProcess.handleMessageForTest(releaseEvent);
        assertEquals("stale process must be ignored", 1, clientTriggered.get());

        hostClient.setSessionStateForTest(process, false, false, true, false, false, false);
        process.handleMessageForTest(releaseEvent);
        hostClient.setSessionStateForTest(process, true, true, true, false, false, false);
        process.handleMessageForTest(releaseEvent);
        hostClient.setSessionStateForTest(process, true, false, false, false, false, false);
        process.handleMessageForTest(releaseEvent);
        hostClient.setSessionStateForTest(process, true, false, true, true, false, false);
        process.handleMessageForTest(releaseEvent);
        hostClient.setSessionStateForTest(process, true, false, true, false, true, false);
        process.handleMessageForTest(releaseEvent);
        hostClient.setSessionStateForTest(process, true, false, true, false, false, true);
        process.handleMessageForTest(releaseEvent);
        hostClient.setSessionStateForTest(process, true, false, true, false, false, false);
        activeFlag.set(false);
        process.handleMessageForTest(releaseEvent);
        assertEquals(1, clientTriggered.get());

        // Restore valid state -> triggers again!
        activeFlag.set(true);
        process.handleMessageForTest(releaseEvent);
        assertEquals(2, clientTriggered.get());

        // Host-mode BotHostProcess ignores center_event completely.
        AtomicInteger hostEventCount = new AtomicInteger();
        JSONObject hostInit = new JSONObject()
                .put("type", "init")
                .put("protocol", 1)
                .put("mode", "host");
        JSONObject hostReady = new JSONObject()
                .put("type", "ready")
                .put("protocol", 1)
                .put("deviceId", "host-1")
                .put("url", "http://127.0.0.1:4321")
                .put("nodeVersion", "v24.0.0")
                .put("platform", "android")
                .put("arch", "arm64");
        BotHostProcess hostProcess = BotHostProcess.createForTest(app, hostInit, new BotHostProcess.Listener() {
            @Override public void onReady(BotHostProcess p, JSONObject ready) { }
            @Override public void onNativeFrame(BotHostProcess p, JSONObject frame) { }
            @Override public void onCenterEvent(BotHostProcess p, String event) { hostEventCount.incrementAndGet(); }
            @Override public void onExit(BotHostProcess p, int exitCode, boolean graceful) { }
        });
        hostProcess.handleMessageForTest(hostReady);
        hostProcess.handleMessageForTest(releaseEvent);
        assertEquals(0, hostEventCount.get());
        assertFalse(hostProcess.isClosedForTest());
    }

    // ---------- 5. 活动态跳过、available 态保护不闪塌、自动检查静默容错 ----------

    @Test
    public void automaticCheckSkipsAllActivePhasesWithoutDisturbingState() throws Exception {
        String[] activePhases = {
                "downloading",
                "downloaded",
                "waiting-permission",
                "waiting-install",
                "waiting-tasks",
                "installing",
                "complete"
        };
        for (String activePhase : activePhases) {
            ClientUpdater updater = newUpdater();
            int beforeFetches = fetchCount.get();
            updater.setStateForTest(activePhase, release(2L));

            JSONObject returned = updater.request(
                    "updateCheck",
                    new JSONObject().put("automatic", true).put("reason", "push"))
                    .get(2, TimeUnit.SECONDS);
            drainIo();

            assertEquals("active phase " + activePhase + " must skip automatic check", beforeFetches, fetchCount.get());
            assertEquals(activePhase, returned.getString("phase"));
            assertEquals(activePhase, status(updater).getString("phase"));
        }
    }

    @Test
    public void availablePhaseDoesNotCollapseDuringAutoCheckAndUpdatesOrClearsOnlyAfterResult() throws Exception {
        ClientUpdater updater = newUpdater();
        // Seed phase=available with v2.
        fetcherRef.set((me, creds, endpoint, arch, currentVersionCode) -> {
            fetchCount.incrementAndGet();
            return release(2L);
        });
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "startup"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals("available", status(updater).getString("phase"));
        assertEquals(2L, status(updater).getJSONObject("release").getLong("versionCode"));

        // Hold an in-flight automatic push check on a latch and verify available + release v2 never collapse!
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch proceed = new CountDownLatch(1);
        fetcherRef.set((me, creds, endpoint, arch, currentVersionCode) -> {
            fetchCount.incrementAndGet();
            started.countDown();
            assertTrue(proceed.await(2, TimeUnit.SECONDS));
            return release(3L);
        });

        JSONObject immediate = updater.request(
                "updateCheck",
                new JSONObject().put("automatic", true).put("reason", "push"))
                .get(2, TimeUnit.SECONDS);
        assertTrue(started.await(2, TimeUnit.SECONDS));
        assertEquals("available", immediate.getString("phase"));
        assertEquals(2L, immediate.getJSONObject("release").getLong("versionCode"));

        JSONObject midFlight = status(updater);
        assertEquals("available", midFlight.getString("phase"));
        assertEquals(2L, midFlight.getJSONObject("release").getLong("versionCode"));

        // Complete with v3 -> now replaces release with v3.
        proceed.countDown();
        drainIo();
        JSONObject updated = status(updater);
        assertEquals("available", updated.getString("phase"));
        assertEquals(3L, updated.getJSONObject("release").getLong("versionCode"));

        // Subsequent 204 -> transitions cleanly from available to up-to-date.
        fetcherRef.set((me, creds, endpoint, arch, currentVersionCode) -> {
            fetchCount.incrementAndGet();
            return null;
        });
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "push"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        JSONObject upToDate = status(updater);
        assertEquals("up-to-date", upToDate.getString("phase"));
        assertFalse(upToDate.has("release"));
    }

    @Test
    public void automaticCheckErrorSilentlyRestoresPreviousStablePhaseWithoutLockingCooldown() throws Exception {
        // Case 1: available (v2) + auto error -> restores available (v2), never enters error, does not lock cooldown.
        ClientUpdater updater = newUpdater();
        fetcherRef.set((me, creds, endpoint, arch, currentVersionCode) -> {
            fetchCount.incrementAndGet();
            return release(2L);
        });
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "startup"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals("available", status(updater).getString("phase"));

        fetcherRef.set((me, creds, endpoint, arch, currentVersionCode) -> {
            fetchCount.incrementAndGet();
            throw new IOException("simulated timeout");
        });
        clockMs.addAndGet(ClientUpdater.COOLDOWN_UPDATES_PAGE_MS);
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "updates-page"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        JSONObject afterAvailableErr = status(updater);
        assertEquals("available", afterAvailableErr.getString("phase"));
        assertEquals(2L, afterAvailableErr.getJSONObject("release").getLong("versionCode"));
        assertFalse(afterAvailableErr.has("message"));

        // Because the failed check did NOT refresh lastCheckAtElapsed, an immediate retry at same timestamp runs!
        int beforeRetry = fetchCount.get();
        fetcherRef.set((me, creds, endpoint, arch, currentVersionCode) -> {
            fetchCount.incrementAndGet();
            return null;
        });
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "updates-page"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        assertEquals(beforeRetry + 1, fetchCount.get());
        assertEquals("up-to-date", status(updater).getString("phase"));

        // Case 2: up-to-date + auto error -> silently restores up-to-date.
        fetcherRef.set((me, creds, endpoint, arch, currentVersionCode) -> {
            fetchCount.incrementAndGet();
            throw new IOException("simulated network drop");
        });
        updater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "push"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        JSONObject afterUpToDateErr = status(updater);
        assertEquals("up-to-date", afterUpToDateErr.getString("phase"));
        assertFalse(afterUpToDateErr.has("message"));

        // Case 3: idle + auto error -> silently restores idle.
        ClientUpdater idleUpdater = newUpdater();
        idleUpdater.request("updateCheck", new JSONObject().put("automatic", true).put("reason", "startup"))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        JSONObject afterIdleErr = status(idleUpdater);
        assertEquals("idle", afterIdleErr.getString("phase"));
        assertFalse(afterIdleErr.has("message"));

        // Contrast: manual check failure DOES enter error phase.
        idleUpdater.request("updateCheck", new JSONObject().put("automatic", false))
                .get(2, TimeUnit.SECONDS);
        drainIo();
        JSONObject afterManualErr = status(idleUpdater);
        assertEquals("error", afterManualErr.getString("phase"));
        assertNotNull(afterManualErr.optString("message", null));
    }
}
