package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/**
 * Android Bot 浏览器主线程队列调度、取消/超时/中断作废与未确认副作用语义的 Robolectric 回归测试。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class BotBrowserMainThreadQueueTest {
    private final ExecutorService workers = Executors.newCachedThreadPool();

    @After
    public void tearDown() {
        workers.shutdownNow();
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }

    @Test
    public void cancelledQueuedHumanInputNeverExecutesWhenMainLooperDrains() throws Exception {
        QueueObservingHandler mainHandler = new QueueObservingHandler(Looper.getMainLooper());
        AtomicLong fakeUptime = new AtomicLong(1_000L);
        BotBrowserManager.AndroidWebViewBackend backend = new BotBrowserManager.AndroidWebViewBackend(
                RuntimeEnvironment.getApplication(), mainHandler, fakeUptime::get, 5_000L, 5_000L);
        RecordingWebView webView = new RecordingWebView(RuntimeEnvironment.getApplication());
        BotBrowserManager.WebViewTabHandle tab = new BotBrowserManager.WebViewTabHandle(webView, 960, 640);

        CountDownLatch posted = new CountDownLatch(1);
        mainHandler.onPostLatch.set(posted);
        AtomicBoolean cancelled = new AtomicBoolean(false);
        JSONObject click = new JSONObject().put("kind", "click").put("x", 0.5).put("y", 0.5);

        Future<?> call = workers.submit(() -> {
            backend.dispatchHumanInput(tab, click, cancelled::get);
            return null;
        });

        assertTrue("输入任务应入队到主线程 Looper", posted.await(2, TimeUnit.SECONDS));
        cancelled.set(true);

        BotBrowserBridge.Failure failure = awaitFailure(call);
        assertEquals("CANCELLED", failure.code);
        assertEquals(BotBrowserBridge.OUTCOME_NOT_SENT, failure.outcome);
        assertTrue(failure.isNotSent());
        assertFalse(failure.isUnconfirmed());

        // 排空主线程队列：已作废的输入任务绝不可执行。
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals(0, webView.touchEvents.get());
    }

    @Test
    public void timedOutQueuedInputAndNavigationNeverExecuteWhenMainLooperDrains() throws Exception {
        QueueObservingHandler mainHandler = new QueueObservingHandler(Looper.getMainLooper());
        AtomicLong fakeUptime = new AtomicLong(1_000L);
        BotBrowserManager.AndroidWebViewBackend backend = new BotBrowserManager.AndroidWebViewBackend(
                RuntimeEnvironment.getApplication(), mainHandler, fakeUptime::get, 500L, 500L);
        RecordingWebView webView = new RecordingWebView(RuntimeEnvironment.getApplication());
        BotBrowserManager.WebViewTabHandle tab = new BotBrowserManager.WebViewTabHandle(webView, 960, 640);

        CountDownLatch postedKey = new CountDownLatch(1);
        mainHandler.onPostLatch.set(postedKey);
        JSONObject keyEvent = new JSONObject().put("kind", "key").put("key", "ENTER");

        Future<?> keyCall = workers.submit(() -> {
            backend.dispatchHumanInput(tab, keyEvent, () -> false);
            return null;
        });

        assertTrue("按键任务应入队到主线程 Looper", postedKey.await(2, TimeUnit.SECONDS));
        fakeUptime.set(1_500L);

        BotBrowserBridge.Failure keyTimeout = awaitFailure(keyCall);
        assertEquals("BROWSER_BUSY", keyTimeout.code);
        assertEquals(BotBrowserBridge.OUTCOME_NOT_SENT, keyTimeout.outcome);
        assertTrue(keyTimeout.isNotSent());

        CountDownLatch postedNav = new CountDownLatch(1);
        mainHandler.onPostLatch.set(postedNav);
        Future<?> navCall = workers.submit(() -> {
            backend.loadUrl(tab, "https://example.com/timed-out", () -> false);
            return null;
        });

        assertTrue("导航任务应入队到主线程 Looper", postedNav.await(2, TimeUnit.SECONDS));
        fakeUptime.set(2_000L);

        BotBrowserBridge.Failure navTimeout = awaitFailure(navCall);
        assertEquals("BROWSER_BUSY", navTimeout.code);
        assertEquals(BotBrowserBridge.OUTCOME_NOT_SENT, navTimeout.outcome);
        assertTrue(navTimeout.isNotSent());

        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals(0, webView.keyEvents.get());
        assertTrue(webView.loadedUrls.isEmpty());
    }

    @Test
    public void mainThreadPreExecutionDeadlineCheckAbortsExpiredQueuedInputEvenBeforeWorkerPolls()
            throws Exception {
        QueueObservingHandler mainHandler = new QueueObservingHandler(Looper.getMainLooper());
        AtomicLong fakeUptime = new AtomicLong(1_000L);
        BotBrowserManager.AndroidWebViewBackend backend = new BotBrowserManager.AndroidWebViewBackend(
                RuntimeEnvironment.getApplication(), mainHandler, fakeUptime::get, 5_000L, 5_000L);
        RecordingWebView webView = new RecordingWebView(RuntimeEnvironment.getApplication());
        BotBrowserManager.WebViewTabHandle tab = new BotBrowserManager.WebViewTabHandle(webView, 960, 640);

        // 先排队一个模拟主线程耗时任务：执行完后时钟已越过后续输入任务的 deadline。
        mainHandler.post(() -> fakeUptime.set(6_000L));

        CountDownLatch posted = new CountDownLatch(1);
        mainHandler.onPostLatch.set(posted);
        JSONObject click = new JSONObject().put("kind", "click").put("x", 0.3).put("y", 0.7);

        Future<?> call = workers.submit(() -> {
            backend.dispatchHumanInput(tab, click, () -> false);
            return null;
        });

        assertTrue("输入任务应排在耗时前置任务之后", posted.await(2, TimeUnit.SECONDS));

        // worker 尚未轮询超时时主线程即排空：主线程执行前检查 deadline 必须主动拦截。
        Shadows.shadowOf(Looper.getMainLooper()).idle();

        BotBrowserBridge.Failure failure = awaitFailure(call);
        assertEquals("BROWSER_BUSY", failure.code);
        assertEquals(BotBrowserBridge.OUTCOME_NOT_SENT, failure.outcome);
        assertTrue(failure.isNotSent());
        assertEquals(0, webView.touchEvents.get());
    }

    @Test
    public void interruptedWorkerInvalidatesQueuedInputAndPreservesInterruptFlag() throws Exception {
        QueueObservingHandler mainHandler = new QueueObservingHandler(Looper.getMainLooper());
        AtomicLong fakeUptime = new AtomicLong(1_000L);
        BotBrowserManager.AndroidWebViewBackend backend = new BotBrowserManager.AndroidWebViewBackend(
                RuntimeEnvironment.getApplication(), mainHandler, fakeUptime::get, 5_000L, 5_000L);
        RecordingWebView webView = new RecordingWebView(RuntimeEnvironment.getApplication());
        BotBrowserManager.WebViewTabHandle tab = new BotBrowserManager.WebViewTabHandle(webView, 960, 640);

        CountDownLatch posted = new CountDownLatch(1);
        mainHandler.onPostLatch.set(posted);
        AtomicReference<Thread> workerThreadRef = new AtomicReference<>();
        AtomicBoolean sawInterruptFlag = new AtomicBoolean(false);
        JSONObject click = new JSONObject().put("kind", "click").put("x", 0.2).put("y", 0.8);

        Future<BotBrowserBridge.Failure> call = workers.submit(() -> {
            workerThreadRef.set(Thread.currentThread());
            try {
                backend.dispatchHumanInput(tab, click, () -> false);
                return null;
            } catch (BotBrowserBridge.Failure failure) {
                sawInterruptFlag.set(Thread.currentThread().isInterrupted());
                Thread.interrupted(); // 清理线程中断位避免影响测试线程池复用。
                return failure;
            }
        });

        assertTrue("输入任务应入队到主线程 Looper", posted.await(2, TimeUnit.SECONDS));
        Thread workerThread = workerThreadRef.get();
        assertNotNull(workerThread);
        workerThread.interrupt();

        BotBrowserBridge.Failure failure = call.get(2, TimeUnit.SECONDS);
        assertNotNull(failure);
        assertEquals("CANCELLED", failure.code);
        assertEquals(BotBrowserBridge.OUTCOME_NOT_SENT, failure.outcome);
        assertTrue(failure.isNotSent());
        assertTrue("中断标志应保留给调用方感知", sawInterruptFlag.get());

        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals(0, webView.touchEvents.get());
    }

    @Test
    public void cancelAfterMainThreadStartedReportsUnconfirmedWithoutDeadlockOrFalseNotSent()
            throws Exception {
        QueueObservingHandler mainHandler = new QueueObservingHandler(Looper.getMainLooper());
        AtomicLong fakeUptime = new AtomicLong(1_000L);
        BotBrowserManager.AndroidWebViewBackend backend = new BotBrowserManager.AndroidWebViewBackend(
                RuntimeEnvironment.getApplication(), mainHandler, fakeUptime::get, 5_000L, 5_000L);
        RecordingWebView webView = new RecordingWebView(RuntimeEnvironment.getApplication());
        BotBrowserManager.WebViewTabHandle tab = new BotBrowserManager.WebViewTabHandle(webView, 960, 640);

        CountDownLatch posted = new CountDownLatch(1);
        mainHandler.onPostLatch.set(posted);
        AtomicBoolean cancelled = new AtomicBoolean(false);
        JSONObject click = new JSONObject().put("kind", "click").put("x", 0.4).put("y", 0.6);

        Future<?> call = workers.submit(() -> {
            backend.dispatchHumanInput(tab, click, cancelled::get);
            return null;
        });

        assertTrue(posted.await(2, TimeUnit.SECONDS));

        AtomicReference<BotBrowserBridge.Failure> observedWhileRunning = new AtomicReference<>();
        webView.onTouchAction.set(() -> {
            // 在主线程已经开始派发触摸副作用期间触发取消，并立即在主线程内等待 worker 退出：
            // 若 worker 无界阻塞等待主线程结束将直接超时死锁。
            cancelled.set(true);
            try {
                observedWhileRunning.set(awaitFailure(call));
            } catch (Exception e) {
                throw new AssertionError("worker 应在有界时间内以未确认失败退出", e);
            }
        });

        Shadows.shadowOf(Looper.getMainLooper()).idle();

        BotBrowserBridge.Failure failure = observedWhileRunning.get();
        assertNotNull(failure);
        assertEquals("ANDROID_NATIVE_UNCONFIRMED", failure.code);
        assertEquals(BotBrowserBridge.OUTCOME_UNCONFIRMED, failure.outcome);
        assertTrue(failure.isUnconfirmed());
        assertFalse(failure.isNotSent());
        assertTrue("副作用已在主线程开始执行", webView.touchEvents.get() >= 1);
    }

    @Test
    public void submittedWebViewJsMutationReportsUnconfirmedAndInvalidatesRevisionOnManager()
            throws Exception {
        QueueObservingHandler mainHandler = new QueueObservingHandler(Looper.getMainLooper());
        AtomicLong fakeUptime = new AtomicLong(10_000L);
        BotBrowserManager.AndroidWebViewBackend realBackend = new BotBrowserManager.AndroidWebViewBackend(
                RuntimeEnvironment.getApplication(), mainHandler, fakeUptime::get, 5_000L, 500L);
        RecordingWebView webView = new RecordingWebView(RuntimeEnvironment.getApplication());
        BotBrowserManager.WebViewTabHandle tabHandle =
                new BotBrowserManager.WebViewTabHandle(webView, 960, 640);
        BotBrowserManager manager = new BotBrowserManager(
                new DelegatingWebViewBackend(realBackend, tabHandle), fakeUptime::get);

        JSONObject opened = manager.open("dev-1", "bot-1", "human", new JSONObject(), () -> false);
        String pageId = opened.getString("pageId");
        long initialRevision = opened.getLong("revision");

        // 1) 未开始即取消的 navigate 保持 revision 与 URL 不变，且不调用 WebView.loadUrl。
        CountDownLatch navPosted = new CountDownLatch(1);
        mainHandler.onPostLatch.set(navPosted);
        AtomicBoolean cancelNav = new AtomicBoolean(false);
        Future<?> navFuture = workers.submit(() -> manager.navigate(
                "dev-1", "bot-1", "agent",
                new JSONObject()
                        .put("pageId", pageId)
                        .put("revision", initialRevision)
                        .put("url", "https://example.com/cancelled-nav"),
                cancelNav::get));

        assertTrue(navPosted.await(2, TimeUnit.SECONDS));
        cancelNav.set(true);
        BotBrowserBridge.Failure navFailure = awaitFailure(navFuture);
        assertEquals("CANCELLED", navFailure.code);
        assertTrue(navFailure.isNotSent());
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertTrue(webView.loadedUrls.isEmpty());
        JSONObject statusAfterCancelledNav = manager.status("dev-1", "bot-1", "human", () -> false);
        assertEquals(initialRevision, statusAfterCancelledNav.getLong("revision"));
        assertEquals("about:blank", statusAfterCancelledNav.getJSONArray("tabs").getJSONObject(0).getString("url"));
        assertFalse(statusAfterCancelledNav.getJSONArray("tabs").getJSONObject(0).getBoolean("loading"));

        // 2) 人类文本输入回退到 evaluateJavascript：脚本已提交至 WebView 后超时，必须报未确认并推进 revision。
        CountDownLatch icPosted = new CountDownLatch(1);
        CountDownLatch evalPosted = new CountDownLatch(1);
        mainHandler.onPostLatch.set(icPosted);
        Future<?> textFuture = workers.submit(() -> manager.input(
                "dev-1", "bot-1",
                new JSONObject()
                        .put("pageId", pageId)
                        .put("revision", initialRevision)
                        .put("event", new JSONObject().put("kind", "text").put("text", "hello")),
                () -> false));

        assertTrue(icPosted.await(2, TimeUnit.SECONDS));
        // 在排空 onCreateInputConnection（返回 null）前先挂接第二步 evaluateJavascript 的入队闩锁。
        mainHandler.onPostLatch.set(evalPosted);
        Shadows.shadowOf(Looper.getMainLooper()).idle();

        assertTrue("文本回退脚本应入队到主线程", evalPosted.await(2, TimeUnit.SECONDS));
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("脚本已提交至 WebView", 1, webView.evalCalls.get());

        // WebView JS 回调尚未返回时超时：不得误报 CANCELLED/BROWSER_BUSY，也不得保留旧 revision 允许盲目重试。
        fakeUptime.addAndGet(500L);
        BotBrowserBridge.Failure evalTimeout = awaitFailure(textFuture);
        assertEquals("ANDROID_NATIVE_UNCONFIRMED", evalTimeout.code);
        assertEquals(BotBrowserBridge.OUTCOME_UNCONFIRMED, evalTimeout.outcome);
        assertTrue(evalTimeout.isUnconfirmed());
        assertFalse(evalTimeout.isNotSent());

        // 沿用旧 revision 重试必须因 revision 已递增而被拒绝，且不会再次向 WebView 派发输入。
        BotBrowserBridge.Failure retryRejected = assertThrows(BotBrowserBridge.Failure.class, () ->
                manager.input("dev-1", "bot-1",
                        new JSONObject()
                                .put("pageId", pageId)
                                .put("revision", initialRevision)
                                .put("event", new JSONObject().put("kind", "click").put("x", 0.5).put("y", 0.5)),
                        () -> false));
        assertEquals("BROWSER_REVISION_MISMATCH", retryRejected.code);
        assertEquals(0, webView.touchEvents.get());
        assertEquals(1, webView.evalCalls.get());
    }

    @Test
    public void abandonedResultCleanupRunsOnceAndMainThreadCallDoesNotDeadlock() throws Exception {
        QueueObservingHandler mainHandler = new QueueObservingHandler(Looper.getMainLooper());
        AtomicLong fakeUptime = new AtomicLong(1_000L);
        BotBrowserManager.AndroidWebViewBackend backend = new BotBrowserManager.AndroidWebViewBackend(
                RuntimeEnvironment.getApplication(), mainHandler, fakeUptime::get, 5_000L, 5_000L);
        RecordingWebView webView = new RecordingWebView(RuntimeEnvironment.getApplication());
        BotBrowserManager.WebViewTabHandle tab = new BotBrowserManager.WebViewTabHandle(webView, 960, 640);

        // 直接在主线程调用：已取消则不执行；未取消则同步执行且不死锁。
        JSONObject click = new JSONObject().put("kind", "click").put("x", 0.5).put("y", 0.5);
        BotBrowserBridge.Failure preCancelled = assertThrows(BotBrowserBridge.Failure.class, () ->
                backend.dispatchHumanInput(tab, click, () -> true));
        assertEquals("CANCELLED", preCancelled.code);
        assertTrue(preCancelled.isNotSent());
        assertEquals(0, webView.touchEvents.get());

        backend.dispatchHumanInput(tab, click, () -> false);
        assertEquals(2, webView.touchEvents.get());

        // 已开始执行后被调用方放弃的资源结果，在主线程完成时应精确清理一次。
        CountDownLatch posted = new CountDownLatch(1);
        mainHandler.onPostLatch.set(posted);
        AtomicBoolean cancelled = new AtomicBoolean(false);
        AtomicInteger cleanupCount = new AtomicInteger(0);
        AtomicReference<BotBrowserBridge.Failure> workerFailure = new AtomicReference<>();
        AtomicReference<Future<?>> callRef = new AtomicReference<>();

        callRef.set(workers.submit(() -> backend.runOnMain(
                () -> {
                    cancelled.set(true);
                    try {
                        workerFailure.set(awaitFailure(callRef.get()));
                    } catch (Exception e) {
                        throw new AssertionError(e);
                    }
                    return "orphan-resource";
                },
                cancelled::get,
                true,
                ignored -> cleanupCount.incrementAndGet())));

        assertTrue(posted.await(2, TimeUnit.SECONDS));
        Shadows.shadowOf(Looper.getMainLooper()).idle();

        assertNotNull(workerFailure.get());
        assertEquals("ANDROID_NATIVE_UNCONFIRMED", workerFailure.get().code);
        assertEquals(BotBrowserBridge.OUTCOME_UNCONFIRMED, workerFailure.get().outcome);
        assertEquals(1, cleanupCount.get());
    }

    private static BotBrowserBridge.Failure awaitFailure(Future<?> future) throws Exception {
        try {
            future.get(2, TimeUnit.SECONDS);
            fail("预期抛出 BotBrowserBridge.Failure");
            return null;
        } catch (ExecutionException execution) {
            Throwable cause = execution.getCause();
            if (cause instanceof BotBrowserBridge.Failure failure) {
                return failure;
            }
            throw new AssertionError("预期 BotBrowserBridge.Failure，实际为: " + cause, cause);
        }
    }

    private static final class QueueObservingHandler extends Handler {
        final AtomicReference<CountDownLatch> onPostLatch = new AtomicReference<>();

        QueueObservingHandler(Looper looper) {
            super(looper);
        }

        @Override
        public boolean sendMessageAtTime(Message msg, long uptimeMillis) {
            boolean posted = super.sendMessageAtTime(msg, uptimeMillis);
            if (posted) {
                CountDownLatch latch = onPostLatch.get();
                if (latch != null) {
                    latch.countDown();
                }
            }
            return posted;
        }
    }

    private static final class RecordingWebView extends WebView {
        final AtomicInteger touchEvents = new AtomicInteger();
        final AtomicInteger keyEvents = new AtomicInteger();
        final AtomicInteger evalCalls = new AtomicInteger();
        final List<String> loadedUrls = Collections.synchronizedList(new ArrayList<>());
        final AtomicReference<Runnable> onTouchAction = new AtomicReference<>();
        final AtomicReference<ValueCallback<String>> lastEvalCallback = new AtomicReference<>();

        RecordingWebView(Context context) {
            super(context);
        }

        @Override
        public boolean dispatchTouchEvent(MotionEvent ev) {
            touchEvents.incrementAndGet();
            Runnable hook = onTouchAction.getAndSet(null);
            if (hook != null) {
                hook.run();
            }
            return true;
        }

        @Override
        public boolean dispatchKeyEvent(KeyEvent event) {
            keyEvents.incrementAndGet();
            return true;
        }

        @Override
        public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
            return null;
        }

        @Override
        public void loadUrl(String url) {
            loadedUrls.add(url);
        }

        @Override
        public void evaluateJavascript(String script, ValueCallback<String> resultCallback) {
            evalCalls.incrementAndGet();
            lastEvalCallback.set(resultCallback);
        }

        @Override public boolean canGoBack() { return false; }
        @Override public boolean canGoForward() { return false; }
        @Override public void stopLoading() { }
        @Override public void onPause() { }
        @Override public void destroy() { }
    }

    /** 仅绕过 Robolectric 下 WebViewFeature.MULTI_PROFILE 探测与构造，其余全部委托真实 AndroidWebViewBackend。 */
    private static final class DelegatingWebViewBackend implements BotBrowserManager.Backend {
        private final BotBrowserManager.AndroidWebViewBackend delegate;
        private final BotBrowserManager.WebViewTabHandle tabHandle;

        DelegatingWebViewBackend(BotBrowserManager.AndroidWebViewBackend delegate,
                BotBrowserManager.WebViewTabHandle tabHandle) {
            this.delegate = delegate;
            this.tabHandle = tabHandle;
        }

        @Override
        public BotBrowserManager.Availability probeAvailability(BooleanSupplier cancelled) {
            return BotBrowserManager.Availability.supported();
        }

        @Override
        public BotBrowserManager.TabHandle createTab(String profileName, int width, int height,
                BotBrowserManager.TabCallbacks callbacks, BooleanSupplier cancelled) {
            return tabHandle;
        }

        @Override
        public void loadUrl(BotBrowserManager.TabHandle tab, String url, BooleanSupplier cancelled)
                throws BotBrowserBridge.Failure {
            delegate.loadUrl(tab, url, cancelled);
        }

        @Override
        public boolean goBack(BotBrowserManager.TabHandle tab, BooleanSupplier cancelled)
                throws BotBrowserBridge.Failure {
            return delegate.goBack(tab, cancelled);
        }

        @Override
        public boolean goForward(BotBrowserManager.TabHandle tab, BooleanSupplier cancelled)
                throws BotBrowserBridge.Failure {
            return delegate.goForward(tab, cancelled);
        }

        @Override
        public void reload(BotBrowserManager.TabHandle tab, BooleanSupplier cancelled)
                throws BotBrowserBridge.Failure {
            delegate.reload(tab, cancelled);
        }

        @Override
        public BotBrowserManager.FrameCapture captureFrame(BotBrowserManager.TabHandle tab,
                int maxWidth, int maxHeight, int maxBytes, String preferredMimeType,
                BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
            return delegate.captureFrame(tab, maxWidth, maxHeight, maxBytes, preferredMimeType, cancelled);
        }

        @Override
        public JSONObject snapshotDom(BotBrowserManager.TabHandle tab, String snapshotToken,
                String source, BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
            return delegate.snapshotDom(tab, snapshotToken, source, cancelled);
        }

        @Override
        public JSONObject actDom(BotBrowserManager.TabHandle tab, String snapshotToken,
                String source, String currentUrl, JSONObject act, BooleanSupplier cancelled)
                throws BotBrowserBridge.Failure {
            return delegate.actDom(tab, snapshotToken, source, currentUrl, act, cancelled);
        }

        @Override
        public void dispatchHumanInput(BotBrowserManager.TabHandle tab, JSONObject event,
                BooleanSupplier cancelled) throws BotBrowserBridge.Failure {
            delegate.dispatchHumanInput(tab, event, cancelled);
        }

        @Override
        public void destroyTab(BotBrowserManager.TabHandle tab) {
            delegate.destroyTab(tab);
        }
    }
}
