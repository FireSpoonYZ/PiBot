package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.Set;
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
        if (schedules != null) ((ScheduledExecutorService) field("executor")).shutdownNow();
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
}
