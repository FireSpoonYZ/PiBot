package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import java.io.File;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/**
 * Native IPC handoff transitions, independent of a live Node process or alarms.
 * The Host manager integration is exercised separately by the Node SQLite tests.
 * Reflection keeps test-only state access out of the native production API.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE)
public class BotHostSchedulesTest {
    private BotHostSchedules schedules;

    @Before public void createIsolatedManager() throws Exception {
        Constructor<BotHostSchedules> constructor = BotHostSchedules.class.getDeclaredConstructor(Context.class);
        constructor.setAccessible(true);
        schedules = constructor.newInstance(RuntimeEnvironment.getApplication());
    }

    @After public void stopUnusedExecutor() throws Exception {
        if (schedules != null) {
            SQLiteDatabase db = (SQLiteDatabase) field("db");
            if (db != null && db.isOpen()) db.close();
            ((ScheduledExecutorService) field("executor")).shutdownNow();
        }
        File dbFile = new File(RuntimeEnvironment.getApplication().getFilesDir(), "bot-host/schedules.sqlite");
        if (dbFile.exists()) dbFile.delete();
    }

    private Object field(String name) throws Exception {
        Field field = BotHostSchedules.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(schedules);
    }

    private Object call(String name, Class<?>[] types, Object... arguments) throws Exception {
        Method method = BotHostSchedules.class.getDeclaredMethod(name, types);
        method.setAccessible(true);
        try {
            return method.invoke(schedules, arguments);
        } catch (InvocationTargetException failure) {
            Throwable cause = failure.getCause();
            if (cause instanceof Exception exception) throw exception;
            throw failure;
        }
    }

    private JSONObject pending(JSONObject run) throws Exception {
        return (JSONObject) call("pendingHandoff", new Class<?>[] {JSONObject.class}, run);
    }

    private void apply(JSONObject run, String kind, JSONObject envelope) throws Exception {
        call("applyEnvelope", new Class<?>[] {JSONObject.class, String.class, JSONObject.class}, run, kind, envelope);
    }

    @SuppressWarnings("unchecked")
    private boolean mayRetry(JSONObject run) throws Exception {
        return ((Set<String>) field("missingRunIds")).contains(run.getString("id"));
    }

    private JSONObject run() throws Exception {
        return new JSONObject().put("id", "run-a").put("taskId", "schedule-a").put("requestId", "occurrence-a")
                .put("owner", new JSONObject().put("deviceId", "device-a").put("botId", "bot-a")
                        .put("conversationId", "primary-a"))
                .put("prompt", "original occurrence").put("skills", new JSONArray().put("original-skill"))
                .put("status", "dispatching").put("submitted", false);
    }

    private JSONObject fence(long epoch) throws Exception {
        return new JSONObject().put("botId", "bot-a").put("conversationId", "primary-a").put("stopEpoch", epoch);
    }

    private JSONObject envelope(Object result) throws Exception {
        return new JSONObject().put("type", "result").put("result", result);
    }

    private JSONObject armed() throws Exception {
        JSONObject run = run();
        apply(run, "getScheduleFence", envelope(fence(7)));
        assertNotNull(pending(run));
        return run;
    }

    private JSONObject receipt(String status, Object submissionId) throws Exception {
        return new JSONObject().put("botId", "bot-a").put("conversationId", "primary-a")
                .put("requestId", "occurrence-a").put("status", status).put("submissionId", submissionId);
    }

    @Test public void fenceAndInputAreFrozenBeforeSubmissionAndNeverRecaptured() throws Exception {
        JSONObject run = armed();
        String originalText = run.getJSONObject("handoff").getJSONObject("input").getString("text");
        assertTrue(originalText.contains("original occurrence"));
        assertTrue(originalText.contains("original-skill"));
        run.put("prompt", "edited definition").put("skills", new JSONArray().put("new-skill"));
        apply(run, "getScheduleFence", envelope(fence(8)));
        JSONObject handoff = run.getJSONObject("handoff");
        assertEquals(7, handoff.getLong("stopEpoch"));
        assertEquals(originalText, handoff.getJSONObject("input").getString("text"));
        assertEquals("occurrence-a", handoff.getJSONObject("input").getString("requestId"));
    }

    @Test public void onlyExplicitMissingResponsesPermitRetryAndThePermissionIsNotPersistent() throws Exception {
        JSONObject run = armed();
        apply(run, "getSubmission", envelope(JSONObject.NULL));
        assertTrue(mayRetry(run));
        JSONObject persisted = new JSONObject(run.toString());
        assertNotNull(pending(persisted));

        // A new process has no permission based only on the persisted snapshot.
        stopUnusedExecutor();
        createIsolatedManager();
        assertFalse(mayRetry(persisted));
        apply(persisted, "getSubmission", new JSONObject().put("type", "result"));
        assertFalse(mayRetry(persisted));
        apply(persisted, "getSubmission", envelope(new JSONObject()));
        assertFalse(mayRetry(persisted));
        apply(persisted, "getSubmission", envelope(JSONObject.NULL));
        assertTrue(mayRetry(persisted));
    }

    @Test public void aTransportFailureClearsMissingPermissionAndRequiresAnotherLookup() throws Exception {
        JSONObject run = armed();
        apply(run, "getSubmission", envelope(JSONObject.NULL));
        assertTrue(mayRetry(run));
        call("applyError", new Class<?>[] {JSONObject.class, String.class, Throwable.class}, run, "submit",
                new BotHostProcess.BridgeException("NOT_CONNECTED", "not-sent", "transport unavailable"));
        assertFalse(mayRetry(run));
        assertEquals("unconfirmed", run.getString("status"));
        assertNotNull(pending(run));
        call("applyError", new Class<?>[] {JSONObject.class, String.class, Throwable.class}, run, "getSubmission",
                new BotHostProcess.BridgeException("SUBMISSION_NOT_FOUND", "unknown", "ambiguous lookup"));
        assertFalse(mayRetry(run));
        call("applyError", new Class<?>[] {JSONObject.class, String.class, Throwable.class}, run, "getSubmission",
                new BotHostProcess.BridgeException("SUBMISSION_NOT_FOUND", "responded", "missing"));
        assertTrue(mayRetry(run));
    }

    @Test public void queuedHostReceiptWithNullNativeIdCannotBeResubmittedAfterMissingLookup() throws Exception {
        JSONObject run = armed();
        apply(run, "submit", envelope(receipt("queued", JSONObject.NULL)));
        assertEquals("queued", run.getString("status"));
        assertTrue(run.isNull("submissionId"));
        assertEquals("accepted", run.getJSONObject("handoff").getString("state"));
        long acceptedAt = run.getJSONObject("handoff").getLong("acceptedAt");
        apply(run, "getSubmission", envelope(JSONObject.NULL));
        assertFalse(mayRetry(run));
        assertNull(pending(run));
        assertEquals(acceptedAt, run.getJSONObject("handoff").getLong("acceptedAt"));
    }

    @Test public void staleEpochCancellationWithNullIdIsTerminalAcceptance() throws Exception {
        JSONObject run = armed();
        apply(run, "submit", envelope(receipt("unanswered", JSONObject.NULL).put("reason", "cancelled")));
        assertEquals("unanswered", run.getString("status"));
        assertTrue(run.has("finishedAt"));
        assertEquals("accepted", run.getJSONObject("handoff").getString("state"));
        assertEquals(7, run.getJSONObject("handoff").getLong("stopEpoch"));
        assertNull(pending(run));
        assertFalse(mayRetry(run));
    }

    @Test public void legacyAmbiguityAndLegacyAcceptanceEvidenceAreQueryOnly() throws Exception {
        JSONObject legacy = run().put("status", "unconfirmed").put("submitted", true);
        apply(legacy, "getSubmission", envelope(JSONObject.NULL));
        assertFalse(mayRetry(legacy));
        assertEquals("unconfirmed", legacy.getString("status"));
        for (JSONObject evidence : new JSONObject[] {
                armed().put("submissionId", 99),
                armed().put("submissionId", JSONObject.NULL).put("submissionStatus", "queued")}) {
            evidence.put("status", "unconfirmed").put("submitted", true);
            apply(evidence, "getSubmission", envelope(JSONObject.NULL));
            assertNull(pending(evidence));
            assertFalse(mayRetry(evidence));
        }
    }

    @Test public void malformedReceiptsDoNotMarkTheHandoffAcceptedOrAllowResubmission() throws Exception {
        JSONObject[] malformed = {
                new JSONObject(),
                receipt("queued", null), // Missing is not an explicit JSON null native ID.
                receipt("done", JSONObject.NULL),
                receipt("done", 99).put("requestId", "other-occurrence"),
                receipt("queued", 1.5),
        };
        for (JSONObject result : malformed) {
            JSONObject run = armed();
            apply(run, "getSubmission", envelope(result));
            assertEquals("unconfirmed", run.getString("status"));
            assertEquals("pending", run.getJSONObject("handoff").getString("state"));
            assertFalse(mayRetry(run));
        }
    }

    @Test public void corruptOrCrossOwnerFencesCannotArmAndBlankInputCannotRecover() throws Exception {
        for (Object epoch : new Object[] {-1, 0.5, 9007199254740992L, "7"}) {
            JSONObject run = run();
            apply(run, "getScheduleFence", envelope(fence(7).put("stopEpoch", epoch)));
            assertFalse(run.has("handoff"));
        }
        JSONObject crossOwner = run();
        apply(crossOwner, "getScheduleFence", envelope(fence(7).put("botId", "another-bot")));
        assertFalse(crossOwner.has("handoff"));
        JSONObject invalidInput = armed();
        invalidInput.getJSONObject("handoff").getJSONObject("input").put("text", "  \n ");
        assertNull(pending(invalidInput));
    }

    @Test public void recoveryKeepsArmedOccurrencesAndSkipsOnlyUnarmedOfflineOccurrences() throws Exception {
        JSONObject recoverable = armed();
        JSONObject unarmed = run().put("id", "unarmed-run");
        JSONObject serialized = new JSONObject().put("version", 1).put("tasks", new JSONArray())
                .put("runs", new JSONArray().put(recoverable).put(unarmed));
        Object state = call("parseState", new Class<?>[] {String.class}, serialized.toString());
        call("neutralizeNeverAttempted", new Class<?>[] {state.getClass()}, state);
        Field runs = state.getClass().getDeclaredField("runs");
        runs.setAccessible(true);
        JSONArray recovered = (JSONArray) runs.get(state);
        assertEquals("dispatching", recovered.getJSONObject(0).getString("status"));
        assertNotNull(pending(recovered.getJSONObject(0)));
        assertFalse(mayRetry(recovered.getJSONObject(0)));
        assertEquals("skipped_offline", recovered.getJSONObject(1).getString("status"));
        assertEquals("offline", recovered.getJSONObject(1).getString("reason"));
    }

    @Test public void publicCallRejectsPrivateScheduleHandoffMethodsWhileScheduleCallAllowsThem() throws Exception {
        Constructor<BotHostManager> ctor = BotHostManager.class.getDeclaredConstructor(Context.class);
        ctor.setAccessible(true);
        BotHostManager manager = ctor.newInstance(RuntimeEnvironment.getApplication());
        Field controlField = BotHostManager.class.getDeclaredField("control");
        controlField.setAccessible(true);
        ExecutorService control = (ExecutorService) controlField.get(manager);
        try {
            for (String method : new String[] {"getScheduleFence", "submitScheduled"}) {
                CompletableFuture<JSONObject> publicCall = manager.call(method, new JSONObject().put("botId", "bot-a"));
                try {
                    publicCall.join();
                    fail("public call must reject " + method);
                } catch (CompletionException error) {
                    Throwable cause = error;
                    while (cause instanceof CompletionException && cause.getCause() != null) cause = cause.getCause();
                    assertTrue(cause instanceof BotHostProcess.BridgeException);
                    BotHostProcess.BridgeException bridge = (BotHostProcess.BridgeException) cause;
                    assertEquals("INVALID_ARGUMENT", bridge.code);
                    assertEquals("not-sent", bridge.outcome);
                }

                CompletableFuture<JSONObject> privateCall =
                        manager.scheduleCall(null, method, new JSONObject().put("botId", "bot-a"));
                try {
                    privateCall.join();
                    fail("scheduleCall without running process must fail with NOT_CONNECTED");
                } catch (CompletionException error) {
                    Throwable cause = error;
                    while (cause instanceof CompletionException && cause.getCause() != null) cause = cause.getCause();
                    assertTrue(cause instanceof BotHostProcess.BridgeException);
                    BotHostProcess.BridgeException bridge = (BotHostProcess.BridgeException) cause;
                    assertEquals("NOT_CONNECTED", bridge.code);
                }
            }
        } finally {
            control.shutdownNow();
        }
    }

    @Test public void getScheduleFencePermanentRejectionTerminatesWhileTransientFailureStaysUnarmed() throws Exception {
        JSONObject transientRun = run();
        call("applyError", new Class<?>[] {JSONObject.class, String.class, Throwable.class}, transientRun,
                "getScheduleFence", new BotHostProcess.BridgeException("RUNTIME_BUSY", "responded", "maintenance"));
        assertEquals("dispatching", transientRun.getString("status"));
        assertFalse(transientRun.getBoolean("submitted"));
        assertFalse(transientRun.has("handoff"));

        call("applyError", new Class<?>[] {JSONObject.class, String.class, Throwable.class}, transientRun,
                "getScheduleFence", new BotHostProcess.BridgeException("BOT_ARCHIVED", "unknown", "ambiguous"));
        assertEquals("dispatching", transientRun.getString("status"));
        assertFalse(transientRun.getBoolean("submitted"));
        assertFalse(transientRun.has("handoff"));

        JSONObject archivedRun = run();
        call("applyError", new Class<?>[] {JSONObject.class, String.class, Throwable.class}, archivedRun,
                "getScheduleFence", new BotHostProcess.BridgeException("BOT_ARCHIVED", "responded", "bot archived"));
        assertEquals("not_sent", archivedRun.getString("status"));
        assertEquals("not_sent", archivedRun.getString("reason"));
        assertTrue(archivedRun.getBoolean("submitted"));
        assertTrue(archivedRun.has("finishedAt"));
        assertFalse(archivedRun.has("handoff"));
    }

    @SuppressWarnings("unchecked")
    @Test public void terminalRunsAreNeverPendingAndDeleteOwnerNeutralizesArmedRunsOnly() throws Exception {
        JSONObject terminalNotSent = armed().put("id", "run-not-sent")
                .put("status", "not_sent").put("reason", "not_sent").put("finishedAt", 1234L).put("submitted", true);
        assertNull(pending(terminalNotSent));
        JSONObject terminalSkipped = armed().put("id", "run-skipped")
                .put("status", "skipped_offline").put("reason", "offline").put("submitted", true);
        assertNull(pending(terminalSkipped));

        JSONObject armedUnconfirmed = armed().put("id", "run-armed").put("status", "unconfirmed").put("submitted", true);
        JSONObject queuedRun = armed().put("id", "run-queued");
        apply(queuedRun, "submit", envelope(receipt("queued", JSONObject.NULL)));
        ((Set<String>) field("missingRunIds")).add("run-armed");

        JSONObject serialized = new JSONObject().put("version", 1).put("tasks", new JSONArray())
                .put("runs", new JSONArray().put(armedUnconfirmed).put(terminalNotSent).put(queuedRun));
        SQLiteDatabase db = (SQLiteDatabase) call("db", new Class<?>[0]);
        Class<?> stateClass = Class.forName("com.example.launcherprobe.BotHostSchedules$State");
        Object state = call("parseState", new Class<?>[] {String.class}, serialized.toString());
        call("save", new Class<?>[] {SQLiteDatabase.class, stateClass}, db, state);

        Class<?> ownerClass = Class.forName("com.example.launcherprobe.BotHostSchedules$Owner");
        Constructor<?> ownerCtor = ownerClass.getDeclaredConstructor(String.class, String.class, String.class);
        ownerCtor.setAccessible(true);
        Object owner = ownerCtor.newInstance("device-a", "bot-a", "primary-a");
        call("deleteOwner", new Class<?>[] {ownerClass}, owner);

        Object loaded = call("load", new Class<?>[] {SQLiteDatabase.class}, db);
        Field runsField = stateClass.getDeclaredField("runs");
        runsField.setAccessible(true);
        JSONArray runs = (JSONArray) runsField.get(loaded);
        assertEquals("skipped_offline", runs.getJSONObject(0).getString("status"));
        assertEquals("task_deleted", runs.getJSONObject(0).getString("reason"));
        assertFalse(mayRetry(runs.getJSONObject(0)));
        assertEquals("not_sent", runs.getJSONObject(1).getString("status"));
        assertEquals(1234L, runs.getJSONObject(1).getLong("finishedAt"));
        assertEquals("queued", runs.getJSONObject(2).getString("status"));
    }

    @Test public void planStepLockedClosesArmedRunOfDeletedTaskAfterMissingLookup() throws Exception {
        JSONObject armedRun = armed().put("status", "unconfirmed").put("submitted", true);
        JSONObject serialized = new JSONObject().put("version", 1).put("tasks", new JSONArray())
                .put("runs", new JSONArray().put(armedRun));
        SQLiteDatabase db = (SQLiteDatabase) call("db", new Class<?>[0]);
        Class<?> stateClass = Class.forName("com.example.launcherprobe.BotHostSchedules$State");
        Object state = call("parseState", new Class<?>[] {String.class}, serialized.toString());
        call("save", new Class<?>[] {SQLiteDatabase.class, stateClass}, db, state);

        Class<?> connClass = Class.forName("com.example.launcherprobe.BotHostSchedules$Connection");
        Constructor<?> connCtor = connClass.getDeclaredConstructor(
                BotHostManager.class, BotHostProcess.class, String.class);
        connCtor.setAccessible(true);
        Object conn = connCtor.newInstance(null, null, "device-a");

        // Before an authoritative missing lookup, still reconcile with getSubmission first.
        Object firstStep = call("planStepLocked", new Class<?>[] {connClass}, conn);
        assertNotNull(firstStep);
        Field inflightField = firstStep.getClass().getDeclaredField("inflight");
        inflightField.setAccessible(true);
        Object inflight = inflightField.get(firstStep);
        Field kindField = inflight.getClass().getDeclaredField("kind");
        kindField.setAccessible(true);
        assertEquals("getSubmission", kindField.get(inflight));

        // Once missing is proven, deleted task closes as skipped_offline rather than submitting.
        apply(armedRun, "getSubmission", envelope(JSONObject.NULL));
        assertTrue(mayRetry(armedRun));
        Object secondStep = call("planStepLocked", new Class<?>[] {connClass}, conn);
        assertNull(secondStep);

        Object loaded = call("load", new Class<?>[] {SQLiteDatabase.class}, db);
        Field runsField = stateClass.getDeclaredField("runs");
        runsField.setAccessible(true);
        JSONObject settled = ((JSONArray) runsField.get(loaded)).getJSONObject(0);
        assertEquals("skipped_offline", settled.getString("status"));
        assertEquals("task_deleted", settled.getString("reason"));
        assertFalse(mayRetry(settled));
    }
}
