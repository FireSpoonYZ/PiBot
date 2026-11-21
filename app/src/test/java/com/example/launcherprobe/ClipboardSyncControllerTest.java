package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.example.launcherprobe.BotHostProcess.BridgeException;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * End-to-end state machine tests for {@link ClipboardSyncController}: independent switch vs group
 * persistence, generation fencing, bounded 1-slot incoming OS clipboard writes, no reconnect
 * replay, immediate stop on disable / Center disconnect / re-pair / explicit exit, and seams.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class ClipboardSyncControllerTest {

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    private ExecutorService worker;
    private ManualExecutor mainExecutor;
    private FakeNativeBridge nativeBridge;
    private ClipboardSyncStorage storage;
    private AtomicReference<BotHostClient.ClipboardCredentials> credsRef;
    private AtomicBoolean lifecycleActive;
    private List<String> osWrites;

    private static final class ManualExecutor implements Executor {
        private final Deque<Runnable> tasks = new ArrayDeque<>();

        @Override
        public synchronized void execute(Runnable command) {
            tasks.addLast(command);
        }

        int pendingCount() {
            synchronized (this) {
                return tasks.size();
            }
        }

        void drainAll() {
            while (true) {
                Runnable next;
                synchronized (this) {
                    next = tasks.pollFirst();
                }
                if (next == null) {
                    return;
                }
                next.run();
            }
        }
    }

    private static final class StartedLink {
        final long handle;
        final String origin;
        final String deviceId;
        final String token;
        final String caPem;
        final String code;
        final ClipboardSyncController.TextReceiver receiver;
        volatile String status = ClipboardSyncController.CONNECTION_CONNECTING;
        volatile long onlineGeneration;
        volatile boolean stopped;

        StartedLink(long handle, String origin, String deviceId, String token, String caPem,
                    String code, ClipboardSyncController.TextReceiver receiver) {
            this.handle = handle;
            this.origin = origin;
            this.deviceId = deviceId;
            this.token = token;
            this.caPem = caPem;
            this.code = code;
            this.receiver = receiver;
        }
    }

    private static final class FakeNativeBridge implements ClipboardSyncController.NativeBridge {
        volatile boolean supported = true;
        volatile boolean nextSendResult = true;
        volatile String nextGeneratedCode = "VALID-GROUP-0001";
        private long nextHandle = -10L; // Exercise negative non-zero JNI handles (only 0 is invalid).
        final List<StartedLink> starts = new ArrayList<>();
        final List<Long> stops = new ArrayList<>();
        final List<String> sentTexts = new ArrayList<>();
        final List<Long> sentGenerations = new ArrayList<>();
        final Map<Long, StartedLink> links = new HashMap<>();

        @Override
        public boolean isSupported() {
            return supported;
        }

        @Override
        public String generateGroupCode() {
            return supported ? nextGeneratedCode : null;
        }

        @Override
        public boolean validGroupCode(String code) {
            return supported && code != null && code.startsWith("VALID-");
        }

        @Override
        public synchronized long start(String origin, String deviceId, String token, String caPem,
                                       String code, ClipboardSyncController.TextReceiver receiver) {
            if (!supported) {
                return 0L;
            }
            long handle = nextHandle--;
            if (handle == 0L) {
                handle = nextHandle--;
            }
            StartedLink link = new StartedLink(handle, origin, deviceId, token, caPem, code, receiver);
            starts.add(link);
            links.put(handle, link);
            return handle;
        }

        @Override
        public synchronized String status(long handle) {
            StartedLink link = links.get(handle);
            if (link == null || link.stopped) {
                return ClipboardSyncController.CONNECTION_OFFLINE;
            }
            return link.status;
        }

        @Override
        public synchronized long onlineGeneration(long handle) {
            StartedLink link = links.get(handle);
            if (link == null || link.stopped) {
                return 0L;
            }
            return link.onlineGeneration;
        }

        @Override
        public synchronized boolean send(long handle, long generation, String text) {
            StartedLink link = links.get(handle);
            if (link == null || link.stopped || generation == 0L || generation != link.onlineGeneration) {
                return false;
            }
            if (!nextSendResult) {
                return false;
            }
            sentGenerations.add(generation);
            sentTexts.add(text);
            return true;
        }

        @Override
        public synchronized void stop(long handle) {
            stops.add(handle);
            StartedLink link = links.get(handle);
            if (link != null) {
                link.stopped = true;
            }
        }

        synchronized StartedLink latestLink() {
            return starts.isEmpty() ? null : starts.get(starts.size() - 1);
        }
    }

    @Before
    public void setUp() throws Exception {
        worker = Executors.newSingleThreadExecutor();
        mainExecutor = new ManualExecutor();
        nativeBridge = new FakeNativeBridge();
        storage = new ClipboardSyncStorage(
                new File(temp.getRoot(), ClipboardSyncStorage.FILE_NAME),
                newAesGcmBox());
        credsRef = new AtomicReference<>();
        lifecycleActive = new AtomicBoolean(true);
        osWrites = new ArrayList<>();
    }

    @After
    public void tearDown() throws Exception {
        worker.shutdownNow();
        worker.awaitTermination(2, TimeUnit.SECONDS);
    }

    private ClipboardSyncController newController(ClipboardSyncController.PrivilegedClipboardAdapter adapter) {
        return new ClipboardSyncController(
                storage,
                nativeBridge,
                credsRef::get,
                lifecycleActive::get,
                osWrites::add,
                mainExecutor,
                adapter,
                worker);
    }

    private static BotHostClient.ClipboardCredentials creds(
            long gen, String origin, String deviceId, String token, String caPem, boolean linkAllowed) {
        ClipboardSyncStorage.Binding binding = ClipboardSyncStorage.Binding.create(origin, deviceId, token, caPem);
        return new BotHostClient.ClipboardCredentials(
                gen, binding.origin, binding.deviceId, token, caPem, binding, linkAllowed, false, null);
    }

    private static ClipboardSyncStorage.CipherBox newAesGcmBox() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES");
        generator.init(256);
        SecretKey key = generator.generateKey();
        SecureRandom random = new SecureRandom();
        return new ClipboardSyncStorage.CipherBox() {
            @Override
            public ClipboardSyncStorage.EncryptedPayload encrypt(byte[] plaintext) throws Exception {
                byte[] iv = new byte[12];
                random.nextBytes(iv);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
                return new ClipboardSyncStorage.EncryptedPayload(iv, cipher.doFinal(plaintext));
            }

            @Override
            public byte[] decrypt(byte[] iv, byte[] ciphertext) throws Exception {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
                return cipher.doFinal(ciphertext);
            }
        };
    }

    private static JSONObject action(String name) throws Exception {
        return new JSONObject().put("action", name);
    }

    private interface ThrowingAction {
        void run() throws Exception;
    }

    private static BridgeException expectBridgeFailure(ThrowingAction call) {
        try {
            call.run();
            fail("expected BridgeException");
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
            return (BridgeException) cause;
        }
    }

    @Test
    public void unpairedStateReportsNotPairedAndRejectsMutations() throws Exception {
        ClipboardSyncController controller = newController(null);

        JSONObject statusReply = controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        assertFalse(statusReply.has("code"));
        JSONObject status = statusReply.getJSONObject("status");
        assertFalse(status.getBoolean("enabled"));
        assertFalse(status.getBoolean("configured"));
        assertEquals("manual", status.getString("mode"));
        assertEquals("notPaired", status.getString("connection"));

        // setEnabled(false) is idempotent when not paired
        JSONObject disableReply = controller.handleAction(
                new JSONObject().put("action", "setEnabled").put("enabled", false)).get(2, TimeUnit.SECONDS);
        assertEquals("notPaired", disableReply.getJSONObject("status").getString("connection"));

        assertEquals("NOT_PAIRED", expectBridgeFailure(() ->
                controller.handleAction(new JSONObject().put("action", "setEnabled").put("enabled", true)).join()).code);
        assertEquals("NOT_PAIRED", expectBridgeFailure(() ->
                controller.handleAction(action("newGroup")).join()).code);
        assertEquals("NOT_PAIRED", expectBridgeFailure(() ->
                controller.handleAction(new JSONObject().put("action", "joinGroup").put("code", "VALID-1")).join()).code);
        assertEquals("NOT_PAIRED", expectBridgeFailure(() ->
                controller.handleAction(action("showCode")).join()).code);
        assertEquals("NOT_PAIRED", expectBridgeFailure(() ->
                controller.sendNow("hello").join()).code);
    }

    @Test
    public void newAndJoinPersistGroupWithoutImplicitlyTurningSwitchOnAndShowCodeIsExplicit() throws Exception {
        credsRef.set(creds(1L, "https://center.example.com", "dev-1", "tok-1", null, true));
        ClipboardSyncController controller = newController(null);

        // Before group exists, showCode fails cleanly.
        assertEquals("NOT_CONFIGURED", expectBridgeFailure(() ->
                controller.handleAction(action("showCode")).join()).code);

        // newGroup creates & persists group, keeps enabled=false, does NOT start native handle.
        JSONObject created = controller.handleAction(action("newGroup")).get(2, TimeUnit.SECONDS);
        assertEquals("VALID-GROUP-0001", created.getString("code"));
        assertFalse(created.getJSONObject("status").getBoolean("enabled"));
        assertTrue(created.getJSONObject("status").getBoolean("configured"));
        assertEquals("off", created.getJSONObject("status").getString("connection"));
        assertTrue(nativeBridge.starts.isEmpty());

        // status NEVER returns code.
        JSONObject statusReply = controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        assertFalse(statusReply.has("code"));
        assertFalse(statusReply.getJSONObject("status").getBoolean("enabled"));
        assertTrue(statusReply.getJSONObject("status").getBoolean("configured"));

        // joinGroup rejects invalid code without clobbering existing group.
        assertEquals("INVALID_GROUP_CODE", expectBridgeFailure(() ->
                controller.handleAction(new JSONObject().put("action", "joinGroup").put("code", "BAD-CODE")).join()).code);

        // joinGroup persists valid trimmed code, keeps enabled=false, and NEVER echoes code.
        JSONObject joined = controller.handleAction(
                new JSONObject().put("action", "joinGroup").put("code", "  VALID-GROUP-JOINED  ")).get(2, TimeUnit.SECONDS);
        assertFalse(joined.has("code"));
        assertFalse(joined.getJSONObject("status").getBoolean("enabled"));
        assertTrue(joined.getJSONObject("status").getBoolean("configured"));
        assertEquals("off", joined.getJSONObject("status").getString("connection"));
        assertTrue(nativeBridge.starts.isEmpty());

        // showCode explicitly reveals the persisted group code.
        JSONObject shown = controller.handleAction(action("showCode")).get(2, TimeUnit.SECONDS);
        assertEquals("VALID-GROUP-JOINED", shown.getString("code"));
    }

    @Test
    public void enableStartsNativeLinkMapsStatusAndCoalescesIncomingToBoundedOneSlot() throws Exception {
        credsRef.set(creds(1L, "https://center.example.com", "dev-1", "tok-1", null, true));
        ClipboardSyncController controller = newController(null);

        controller.handleAction(action("newGroup")).get(2, TimeUnit.SECONDS);
        JSONObject enabled = controller.handleAction(
                new JSONObject().put("action", "setEnabled").put("enabled", true)).get(2, TimeUnit.SECONDS);
        assertFalse(enabled.has("code"));
        assertTrue(enabled.getJSONObject("status").getBoolean("enabled"));
        assertEquals("connecting", enabled.getJSONObject("status").getString("connection"));

        StartedLink link = nativeBridge.latestLink();
        assertNotNull(link);
        assertEquals("https://center.example.com", link.origin);
        assertEquals("dev-1", link.deviceId);
        assertEquals("tok-1", link.token);
        assertNull(link.caPem);
        assertEquals("VALID-GROUP-0001", link.code);

        // Transition native link to online (exercise negative non-zero generation too).
        link.status = ClipboardSyncController.CONNECTION_ONLINE;
        link.onlineGeneration = -7L;
        assertEquals("online", controller.handleAction(action("status")).get(2, TimeUnit.SECONDS)
                .getJSONObject("status").getString("connection"));

        // Sanitize arbitrary native status strings (never leak arbitrary text/plaintext).
        link.status = "leaked-clipboard-plaintext";
        assertEquals("offline", controller.handleAction(action("status")).get(2, TimeUnit.SECONDS)
                .getJSONObject("status").getString("connection"));
        link.status = ClipboardSyncController.CONNECTION_CERTIFICATE_ERROR;
        assertEquals("certificateError", controller.handleAction(action("status")).get(2, TimeUnit.SECONDS)
                .getJSONObject("status").getString("connection"));
        link.status = ClipboardSyncController.CONNECTION_ONLINE;

        // Burst of 5 incoming texts before main thread drains -> bounded to 1 latest OS write!
        link.receiver.onText(-7L, "msg-1");
        link.receiver.onText(-7L, "msg-2");
        link.receiver.onText(-7L, "msg-3");
        link.receiver.onText(-7L, "msg-4");
        link.receiver.onText(-7L, "msg-5");
        assertEquals(1, mainExecutor.pendingCount());

        mainExecutor.drainAll();
        assertEquals(1, osWrites.size());
        assertEquals("msg-5", osWrites.get(0));
    }

    @Test
    public void generationFencingStopsImmediatelyOnDisableReconnectDisconnectRepairAndExit() throws Exception {
        credsRef.set(creds(1L, "https://center.example.com", "dev-1", "tok-1", null, true));
        ClipboardSyncController controller = newController(null);

        controller.handleAction(action("newGroup")).get(2, TimeUnit.SECONDS);
        controller.handleAction(new JSONObject().put("action", "setEnabled").put("enabled", true)).get(2, TimeUnit.SECONDS);
        StartedLink link1 = nativeBridge.latestLink();
        link1.status = ClipboardSyncController.CONNECTION_ONLINE;
        link1.onlineGeneration = 11L;

        // 1) No reconnect replay: queue incoming for gen 11, then reconnect advances onlineGeneration to 12.
        link1.receiver.onText(11L, "stale-before-reconnect");
        link1.onlineGeneration = 12L;
        mainExecutor.drainAll();
        assertTrue("stale generation must not be written after reconnect", osWrites.isEmpty());

        // Also invalid generation 0 is ignored immediately.
        link1.receiver.onText(0L, "zero-gen");
        mainExecutor.drainAll();
        assertTrue(osWrites.isEmpty());

        // 2) Disable immediately fences queued pending write AND stops native handle.
        link1.receiver.onText(12L, "queued-before-disable");
        JSONObject disabled = controller.handleAction(
                new JSONObject().put("action", "setEnabled").put("enabled", false)).get(2, TimeUnit.SECONDS);
        assertEquals("off", disabled.getJSONObject("status").getString("connection"));
        assertTrue(link1.stopped);
        mainExecutor.drainAll();
        assertTrue("pending write must be discarded on disable", osWrites.isEmpty());

        // Re-enable for re-pair / credential change test.
        controller.handleAction(new JSONObject().put("action", "setEnabled").put("enabled", true)).get(2, TimeUnit.SECONDS);
        StartedLink link2 = nativeBridge.latestLink();
        link2.status = ClipboardSyncController.CONNECTION_ONLINE;
        link2.onlineGeneration = 20L;
        link2.receiver.onText(20L, "queued-before-repair");

        // 3) Re-pair to new token (binding change): stops old handle, drops pending write, NEVER migrates group!
        credsRef.set(creds(2L, "https://center.example.com", "dev-1", "tok-2-rotated", null, true));
        controller.onCenterStateChanged(false);
        JSONObject afterRepair = controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        assertTrue(link2.stopped);
        mainExecutor.drainAll();
        assertTrue(osWrites.isEmpty());
        assertFalse(afterRepair.getJSONObject("status").getBoolean("enabled"));
        assertFalse(afterRepair.getJSONObject("status").getBoolean("configured"));
        assertEquals("off", afterRepair.getJSONObject("status").getString("connection"));

        // Configure and enable under binding 2, then test explicit exit (shutdown).
        controller.handleAction(action("newGroup")).get(2, TimeUnit.SECONDS);
        controller.handleAction(new JSONObject().put("action", "setEnabled").put("enabled", true)).get(2, TimeUnit.SECONDS);
        StartedLink link3 = nativeBridge.latestLink();
        link3.status = ClipboardSyncController.CONNECTION_ONLINE;
        link3.onlineGeneration = 30L;
        link3.receiver.onText(30L, "queued-before-exit");

        // 4) Explicit exit stops handle and fences pending write without erasing persisted state.
        lifecycleActive.set(false);
        controller.shutdown().get(2, TimeUnit.SECONDS);
        assertTrue(link3.stopped);
        mainExecutor.drainAll();
        assertTrue(osWrites.isEmpty());

        // On next service start with same credentials, state is still persisted and resumes.
        lifecycleActive.set(true);
        controller.onLifecycleStarted();
        JSONObject resumed = controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        assertTrue(resumed.getJSONObject("status").getBoolean("enabled"));
        assertTrue(resumed.getJSONObject("status").getBoolean("configured"));
        StartedLink link4 = nativeBridge.latestLink();
        assertTrue(link4 != link3);

        // 5) Center disconnect stops handle immediately and transitions to notPaired.
        credsRef.set(null);
        controller.onCenterStateChanged(true);
        JSONObject disconnected = controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        assertTrue(link4.stopped);
        assertEquals("notPaired", disconnected.getJSONObject("status").getString("connection"));
        assertFalse(disconnected.getJSONObject("status").getBoolean("configured"));
    }

    @Test
    public void sendNowRequiresOnlineGenerationAndNeverReturnsPlaintext() throws Exception {
        credsRef.set(creds(1L, "https://center.example.com", "dev-1", "tok-1", null, true));
        ClipboardSyncController controller = newController(null);

        controller.handleAction(action("newGroup")).get(2, TimeUnit.SECONDS);
        // Switch is off -> NOT_ENABLED.
        assertEquals("NOT_ENABLED", expectBridgeFailure(() -> controller.sendNow("secret").join()).code);

        controller.handleAction(new JSONObject().put("action", "setEnabled").put("enabled", true)).get(2, TimeUnit.SECONDS);
        StartedLink link = nativeBridge.latestLink();

        // Still connecting (onlineGeneration == 0) -> NOT_ONLINE (no queueing/replay).
        assertEquals("NOT_ONLINE", expectBridgeFailure(() -> controller.sendNow("secret").join()).code);
        assertTrue(nativeBridge.sentTexts.isEmpty());

        // Online -> sends with exact online generation and returns status only (no plaintext, no code).
        link.status = ClipboardSyncController.CONNECTION_ONLINE;
        link.onlineGeneration = 99L;
        JSONObject sentReply = controller.sendNow("secret-clipboard-payload").get(2, TimeUnit.SECONDS);
        assertEquals(1, nativeBridge.sentTexts.size());
        assertEquals("secret-clipboard-payload", nativeBridge.sentTexts.get(0));
        assertEquals(Long.valueOf(99L), nativeBridge.sentGenerations.get(0));
        assertFalse(sentReply.has("code"));
        assertFalse(sentReply.toString().contains("secret-clipboard-payload"));
        assertEquals("online", sentReply.getJSONObject("status").getString("connection"));

        // Direct "sendNow" via handleAction is rejected (must go through private clipboardSyncSend).
        assertEquals("INVALID_ARGUMENT", expectBridgeFailure(() ->
                controller.handleAction(action("sendNow")).join()).code);
    }

    @Test
    public void unsupportedNativeReportsUnsupportedModeAndConnection() throws Exception {
        nativeBridge.supported = false;
        credsRef.set(creds(1L, "https://center.example.com", "dev-1", "tok-1", null, true));
        ClipboardSyncController controller = newController(null);

        JSONObject statusReply = controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        JSONObject status = statusReply.getJSONObject("status");
        assertEquals("unsupported", status.getString("mode"));
        assertEquals("unsupported", status.getString("connection"));
        assertEquals("UNSUPPORTED", expectBridgeFailure(() ->
                controller.handleAction(action("newGroup")).join()).code);
    }

    private static final class FakePrivilegedAdapter
            implements ClipboardSyncController.PrivilegedClipboardAdapter {
        volatile BridgeException prerequisiteError;
        volatile boolean startSucceeds = true;
        volatile boolean listenerActive;
        volatile String nextText = "from-privileged-adapter";
        final AtomicInteger startCount = new AtomicInteger();
        final AtomicInteger stopCount = new AtomicInteger();
        final AtomicInteger readCount = new AtomicInteger();
        final AtomicReference<Runnable> onChangeRef = new AtomicReference<>();
        final AtomicReference<Runnable> onUnavailableRef = new AtomicReference<>();

        @Override
        public void checkAuthorizationPrerequisites() throws BridgeException {
            BridgeException err = prerequisiteError;
            if (err != null) {
                throw err;
            }
        }

        @Override
        public boolean isListenerActive() {
            return listenerActive;
        }

        @Override
        public boolean startListening(Runnable onPossibleLocalChange, Runnable onListenerUnavailable) {
            startCount.incrementAndGet();
            if (!startSucceeds) {
                listenerActive = false;
                return false;
            }
            onChangeRef.set(onPossibleLocalChange);
            onUnavailableRef.set(onListenerUnavailable);
            listenerActive = true;
            return true;
        }

        @Override
        public void stopListening() {
            stopCount.incrementAndGet();
            listenerActive = false;
            onChangeRef.set(null);
            onUnavailableRef.set(null);
        }

        @Override
        public String readSendableText() {
            readCount.incrementAndGet();
            return nextText;
        }
    }

    @Test
    public void backgroundAuthorizationRequiresExplicitConsentAndActiveOnlineLink() throws Exception {
        credsRef.set(creds(1L, "https://center.example.com", "dev-1", "tok-1", null, true));
        FakePrivilegedAdapter adapter = new FakePrivilegedAdapter();
        ClipboardSyncController controller = newController(adapter);

        controller.handleAction(action("newGroup")).get(2, TimeUnit.SECONDS);
        controller.handleAction(new JSONObject().put("action", "setEnabled").put("enabled", true))
                .get(2, TimeUnit.SECONDS);
        StartedLink link = nativeBridge.latestLink();
        link.status = ClipboardSyncController.CONNECTION_ONLINE;
        link.onlineGeneration = 55L;

        // Without explicit authorizeBackground, stays manual and NEVER starts listener (even if Shizuku ready).
        JSONObject beforeAuth = controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        assertEquals("manual", beforeAuth.getJSONObject("status").getString("mode"));
        assertFalse(beforeAuth.getJSONObject("status").getBoolean("backgroundAuthorized"));
        assertEquals(0, adapter.startCount.get());

        // Prerequisite failure rejects authorization and leaves backgroundAuthorized=false.
        adapter.prerequisiteError = new BridgeException("SHIZUKU_PERMISSION_REQUIRED", "not-sent", "未授权");
        assertEquals("SHIZUKU_PERMISSION_REQUIRED", expectBridgeFailure(() ->
                controller.handleAction(action("authorizeBackground")).join()).code);
        JSONObject afterFailedAuth = controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        assertFalse(afterFailedAuth.getJSONObject("status").getBoolean("backgroundAuthorized"));
        assertEquals(0, adapter.startCount.get());

        // Explicit authorizeBackground when active-online arms listener with NO initial copy.
        adapter.prerequisiteError = null;
        JSONObject authed = controller.handleAction(action("authorizeBackground")).get(2, TimeUnit.SECONDS);
        assertTrue(authed.getJSONObject("status").getBoolean("backgroundAuthorized"));
        assertEquals("automatic", authed.getJSONObject("status").getString("mode"));
        assertEquals(1, adapter.startCount.get());
        assertEquals("enrollment must never trigger an initial read", 0, adapter.readCount.get());
        assertTrue(nativeBridge.sentTexts.isEmpty());

        // Subsequent clipboard change publishes with exact onlineGeneration.
        Runnable gen55Callback = adapter.onChangeRef.get();
        assertNotNull(gen55Callback);
        gen55Callback.run();
        controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        assertEquals(1, adapter.readCount.get());
        assertEquals(1, nativeBridge.sentTexts.size());
        assertEquals("from-privileged-adapter", nativeBridge.sentTexts.get(0));
        assertEquals(Long.valueOf(55L), nativeBridge.sentGenerations.get(0));

        // Reconnect advances onlineGeneration to 56: stale callback from gen 55 must NOT read or send.
        link.onlineGeneration = 56L;
        gen55Callback.run();
        controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        assertEquals("stale gen callback must not issue IPC read", 1, adapter.readCount.get());
        assertEquals(1, nativeBridge.sentTexts.size());
        assertEquals("reconnect re-arms listener for new onlineGeneration", 2, adapter.startCount.get());

        // Disable stops/unbinds listener immediately while keeping persisted backgroundAuthorized=true.
        JSONObject disabled = controller.handleAction(
                new JSONObject().put("action", "setEnabled").put("enabled", false)).get(2, TimeUnit.SECONDS);
        assertEquals("manual", disabled.getJSONObject("status").getString("mode"));
        assertTrue(disabled.getJSONObject("status").getBoolean("backgroundAuthorized"));
        assertFalse(adapter.listenerActive);

        // Re-enable while still connecting (onlineGeneration == 0): must NOT start listener until online.
        int startsBeforeReenable = adapter.startCount.get();
        JSONObject connecting = controller.handleAction(
                new JSONObject().put("action", "setEnabled").put("enabled", true)).get(2, TimeUnit.SECONDS);
        assertEquals("connecting", connecting.getJSONObject("status").getString("connection"));
        assertEquals("manual", connecting.getJSONObject("status").getString("mode"));
        assertEquals(startsBeforeReenable, adapter.startCount.get());
    }

    @Test
    public void revokeAndShizukuFailureFallbackToManualWhileKeepingSendNowAndReceive() throws Exception {
        credsRef.set(creds(1L, "https://center.example.com", "dev-1", "tok-1", null, true));
        FakePrivilegedAdapter adapter = new FakePrivilegedAdapter();
        ClipboardSyncController controller = newController(adapter);

        controller.handleAction(action("newGroup")).get(2, TimeUnit.SECONDS);
        // Authorize while off: must NOT auto-enable or start listener.
        JSONObject authedOff = controller.handleAction(action("authorizeBackground")).get(2, TimeUnit.SECONDS);
        assertFalse(authedOff.getJSONObject("status").getBoolean("enabled"));
        assertTrue(authedOff.getJSONObject("status").getBoolean("backgroundAuthorized"));
        assertEquals("manual", authedOff.getJSONObject("status").getString("mode"));
        assertEquals(0, adapter.startCount.get());

        controller.handleAction(new JSONObject().put("action", "setEnabled").put("enabled", true))
                .get(2, TimeUnit.SECONDS);
        StartedLink link = nativeBridge.latestLink();
        link.status = ClipboardSyncController.CONNECTION_ONLINE;
        link.onlineGeneration = 77L;

        // If Shizuku startListening fails (e.g. OEM restriction), mode stays manual; sendNow & receive still work.
        adapter.startSucceeds = false;
        JSONObject failedBind = controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        assertEquals("manual", failedBind.getJSONObject("status").getString("mode"));
        assertTrue(failedBind.getJSONObject("status").getBoolean("backgroundAuthorized"));
        assertFalse(adapter.listenerActive);

        controller.sendNow("manual-fallback-text").get(2, TimeUnit.SECONDS);
        assertEquals(1, nativeBridge.sentTexts.size());
        assertEquals("manual-fallback-text", nativeBridge.sentTexts.get(0));

        link.receiver.onText(77L, "remote-incoming-text");
        mainExecutor.drainAll();
        assertEquals(1, osWrites.size());
        assertEquals("remote-incoming-text", osWrites.get(0));

        // Recover via explicit authorizeBackground, then simulate runtime listener loss (binder death).
        adapter.startSucceeds = true;
        JSONObject recovered = controller.handleAction(action("authorizeBackground")).get(2, TimeUnit.SECONDS);
        assertEquals("automatic", recovered.getJSONObject("status").getString("mode"));
        assertTrue(adapter.listenerActive);

        Runnable unavailableCallback = adapter.onUnavailableRef.get();
        assertNotNull(unavailableCallback);
        adapter.listenerActive = false;
        unavailableCallback.run();
        JSONObject afterLoss = controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        assertEquals("manual", afterLoss.getJSONObject("status").getString("mode"));

        // Explicit revokeBackground removes consent while preserving enabled & group and manual/receive paths.
        JSONObject revoked = controller.handleAction(action("revokeBackground")).get(2, TimeUnit.SECONDS);
        assertFalse(revoked.getJSONObject("status").getBoolean("backgroundAuthorized"));
        assertTrue(revoked.getJSONObject("status").getBoolean("enabled"));
        assertTrue(revoked.getJSONObject("status").getBoolean("configured"));
        assertEquals("manual", revoked.getJSONObject("status").getString("mode"));

        // Re-authorize, then re-pair to a new credential binding -> backgroundAuthorized resets to false.
        controller.handleAction(action("authorizeBackground")).get(2, TimeUnit.SECONDS);
        credsRef.set(creds(2L, "https://center.example.com", "dev-1", "tok-2-repaired", null, true));
        controller.onCenterStateChanged(false);
        JSONObject afterRepair = controller.handleAction(action("status")).get(2, TimeUnit.SECONDS);
        assertFalse(afterRepair.getJSONObject("status").getBoolean("backgroundAuthorized"));
        assertEquals("manual", afterRepair.getJSONObject("status").getString("mode"));
        assertFalse(adapter.listenerActive);
    }
}
