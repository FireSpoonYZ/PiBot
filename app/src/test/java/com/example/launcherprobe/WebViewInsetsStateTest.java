package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Unit tests for {@link WebViewInsetsState}: CSS px rounding, safe-area stability across IME
 * open/close, per-frame IME animation deferral &amp; deduplication, and frontend JS contract.
 */
public class WebViewInsetsStateTest {

    @Test
    public void convertsPhysicalPxToCssPxWithClampingAndSafeDensity() {
        assertEquals(0, WebViewInsetsState.pxToCssPx(0, 3.0f));
        assertEquals(0, WebViewInsetsState.pxToCssPx(-24, 3.0f));
        assertEquals(24, WebViewInsetsState.pxToCssPx(72, 3.0f));
        assertEquals(36, WebViewInsetsState.pxToCssPx(100, 2.75f));
        assertEquals(305, WebViewInsetsState.pxToCssPx(800, 2.625f));
        assertEquals(48, WebViewInsetsState.pxToCssPx(48, 0f));
        assertEquals(48, WebViewInsetsState.pxToCssPx(48, -2f));
        assertEquals(48, WebViewInsetsState.pxToCssPx(48, Float.NaN));
    }

    @Test
    public void safeBottomNeverZerosWhenImeOpensAndRedundantAppliesAreSkipped() {
        WebViewInsetsState state = new WebViewInsetsState();

        WebViewInsetsState.ApplyResult initial = state.onApplyInsets(36, 24, 0);
        assertTrue(initial.shouldSyncFull);
        assertFalse(initial.shouldSyncImeOnly);
        assertFalse(initial.dispatchImeChange);
        assertTrue(initial.shouldUpdateDocStart);
        assertEquals(36, initial.safeTopCssPx);
        assertEquals(24, initial.safeBottomCssPx);
        assertEquals(0, initial.dispatchedImeBottomCssPx);
        state.markDocStartRegistered(initial.safeTopCssPx, initial.safeBottomCssPx, initial.settledImeBottomCssPx);

        // Identical insets dispatch produces zero redundant JS calls.
        WebViewInsetsState.ApplyResult duplicate = state.onApplyInsets(36, 24, 0);
        assertFalse(duplicate.shouldSyncFull);
        assertFalse(duplicate.shouldSyncImeOnly);
        assertFalse(duplicate.dispatchImeChange);
        assertFalse(duplicate.shouldUpdateDocStart);

        // Non-animated IME open preserves safeBottom=24 and dispatches lightweight IME-only update.
        WebViewInsetsState.ApplyResult imeOpen = state.onApplyInsets(36, 24, 312);
        assertFalse(imeOpen.shouldSyncFull);
        assertTrue(imeOpen.shouldSyncImeOnly);
        assertTrue(imeOpen.dispatchImeChange);
        assertTrue(imeOpen.shouldUpdateDocStart);
        assertEquals(24, imeOpen.safeBottomCssPx);
        assertEquals(312, imeOpen.dispatchedImeBottomCssPx);
        assertEquals(24, state.getSafeBottomCssPx());
    }

    @Test
    public void defersImeJumpDuringAnimationAndDeduplicatesPerFrameUpdates() {
        WebViewInsetsState state = new WebViewInsetsState();
        WebViewInsetsState.ApplyResult initial = state.onApplyInsets(36, 24, 0);
        state.markDocStartRegistered(initial.safeTopCssPx, initial.safeBottomCssPx, initial.settledImeBottomCssPx);

        Object anim = new Object();
        state.onImeAnimationPrepare(anim);
        assertTrue(state.isImeAnimating());

        // Android delivers end-state ime=320 in onApplyWindowInsets immediately after onPrepare.
        // State must NOT snap --ime-bottom to 320 before onProgress runs.
        WebViewInsetsState.ApplyResult duringAnim = state.onApplyInsets(36, 24, 320);
        assertFalse(duringAnim.shouldSyncFull);
        assertFalse(duringAnim.shouldSyncImeOnly);
        assertFalse(duringAnim.dispatchImeChange);
        assertEquals(0, duringAnim.dispatchedImeBottomCssPx);
        assertEquals(320, duringAnim.settledImeBottomCssPx);

        // Frame 1: 0 -> 0 (unchanged) skipped.
        assertFalse(state.onImeAnimationProgress(0).shouldDispatchIme);

        // Frame 2: 0 -> 64 dispatched without rewriting document-start script.
        WebViewInsetsState.ImeFrameResult f2 = state.onImeAnimationProgress(64);
        assertTrue(f2.shouldDispatchIme);
        assertFalse(f2.shouldUpdateDocStart);
        assertEquals(64, f2.imeBottomCssPx);

        // Frame 3: same rounded value 64 skipped.
        assertFalse(state.onImeAnimationProgress(64).shouldDispatchIme);

        // Frame 4: 64 -> 318 dispatched.
        WebViewInsetsState.ImeFrameResult f4 = state.onImeAnimationProgress(318);
        assertTrue(f4.shouldDispatchIme);
        assertEquals(318, f4.imeBottomCssPx);

        // onEnd settles final height (320) and updates document-start script once.
        WebViewInsetsState.ImeFrameResult end = state.onImeAnimationEnd(anim, 320);
        assertFalse(state.isImeAnimating());
        assertTrue(end.shouldDispatchIme);
        assertTrue(end.shouldUpdateDocStart);
        assertEquals(320, end.imeBottomCssPx);
        assertEquals(24, end.safeBottomCssPx);
        state.markDocStartRegistered(end.safeTopCssPx, end.safeBottomCssPx, end.imeBottomCssPx);

        // Closing animation where final onProgress already hit 0 skips duplicate IME JS on onEnd.
        Object closeAnim = new Object();
        state.onImeAnimationPrepare(closeAnim);
        state.onApplyInsets(36, 24, 0);
        assertTrue(state.onImeAnimationProgress(120).shouldDispatchIme);
        assertTrue(state.onImeAnimationProgress(0).shouldDispatchIme);
        WebViewInsetsState.ImeFrameResult closeEnd = state.onImeAnimationEnd(closeAnim, 0);
        assertFalse(closeEnd.shouldDispatchIme);
        assertTrue(closeEnd.shouldUpdateDocStart);
        assertEquals(0, closeEnd.imeBottomCssPx);
    }

    @Test
    public void overlappingReversedImeAnimationsOnlySettleWhenLastEnds() {
        WebViewInsetsState state = new WebViewInsetsState();
        state.onApplyInsets(32, 20, 0);
        state.markDocStartRegistered(32, 20, 0);

        Object openAnim = new Object();
        Object closeAnim = new Object();
        state.onImeAnimationPrepare(openAnim);
        state.onApplyInsets(32, 20, 300);
        assertTrue(state.onImeAnimationProgress(150).shouldDispatchIme);

        // Reversed mid-flight before openAnim ends.
        state.onImeAnimationPrepare(closeAnim);
        state.onApplyInsets(32, 20, 0);
        WebViewInsetsState.ImeFrameResult openEnd = state.onImeAnimationEnd(openAnim, 0);
        assertFalse(openEnd.shouldDispatchIme);
        assertFalse(openEnd.shouldUpdateDocStart);
        assertTrue(state.isImeAnimating());
        assertEquals(150, state.getDispatchedImeBottomCssPx());

        assertTrue(state.onImeAnimationProgress(60).shouldDispatchIme);
        WebViewInsetsState.ImeFrameResult closeEnd = state.onImeAnimationEnd(closeAnim, 0);
        assertFalse(state.isImeAnimating());
        assertTrue(closeEnd.shouldDispatchIme);
        assertEquals(0, closeEnd.imeBottomCssPx);
    }

    @Test
    public void seedInitialInsetsIgnoresUnattachedAllZeroFallback() {
        WebViewInsetsState state = new WebViewInsetsState();
        assertFalse(state.seedInitialInsets(0, 0, 0, false));
        assertFalse(state.hasInsets());
        assertNull(state.onPageReady());

        assertTrue(state.seedInitialInsets(36, 24, 0, false));
        assertTrue(state.hasInsets());
        assertEquals(36, state.getSafeTopCssPx());
        assertEquals(24, state.getSafeBottomCssPx());

        // Subsequent seed does not overwrite real insets.
        assertFalse(state.seedInitialInsets(10, 10, 0, true));
        assertEquals(36, state.getSafeTopCssPx());

        // First page ready syncs the seeded values.
        WebViewInsetsState.PageSyncResult sync = state.onPageReady();
        assertNotNull(sync);
        assertEquals(36, sync.safeTopCssPx);
        assertEquals(24, sync.safeBottomCssPx);
        assertEquals(0, sync.imeBottomCssPx);
        assertFalse(sync.dispatchImeChange);

        // Reloading a page resets page-dispatch flag and re-injects insets on page ready.
        state.markDocStartRegistered(36, 24, 0);
        assertFalse(state.needsDocStartUpdate());
        state.onPageStarted();
        WebViewInsetsState.ApplyResult afterNav = state.onApplyInsets(36, 24, 0);
        assertTrue(afterNav.shouldSyncFull);
        assertFalse(afterNav.shouldUpdateDocStart);

        // Recreating a WebView marks doc-start script as needing re-registration.
        state.resetForNewWebView();
        assertTrue(state.needsDocStartUpdate());
    }

    @Test
    public void generatedScriptsMatchExactFrontendContract() {
        String docStart = WebViewInsetsState.buildDocumentStartScript(36, 24, 0);
        assertTrue(docStart.contains("localStorage.setItem('pibot.safe-area-insets.v1',JSON.stringify({top:t,bottom:b}))"));
        assertTrue(docStart.contains("var t=36,b=24,i=0;"));
        assertTrue(docStart.contains("--safe-area-inset-top"));
        assertTrue(docStart.contains("--safe-area-inset-bottom"));
        assertTrue(docStart.contains("--ime-bottom"));
        assertTrue(docStart.contains("r.dataset.insetsReady='1'"));
        assertTrue(docStart.contains("s.visibility=''"));
        assertTrue(docStart.contains("new CustomEvent('pibot:insets-ready',{detail:{top:t,bottom:b,imeBottom:i}})"));
        assertTrue(docStart.contains("MutationObserver"));

        String fullSyncNoIme = WebViewInsetsState.buildInsetsSyncScript(40, 20, 0, false);
        assertTrue(fullSyncNoIme.contains("localStorage.setItem('pibot.safe-area-insets.v1',JSON.stringify({top:t,bottom:b}))"));
        assertTrue(fullSyncNoIme.contains("r.dataset.insetsReady='1'"));
        assertTrue(fullSyncNoIme.contains("s.visibility=''"));
        assertTrue(fullSyncNoIme.contains("pibot:insets-ready"));
        assertFalse(fullSyncNoIme.contains("pibot:ime-change"));

        String fullSyncWithIme = WebViewInsetsState.buildInsetsSyncScript(40, 20, 280, true);
        assertTrue(fullSyncWithIme.contains("pibot:insets-ready"));
        assertTrue(fullSyncWithIme.contains("new CustomEvent('pibot:ime-change',{detail:{imeBottom:i}})"));

        String imeOnly = WebViewInsetsState.buildImeUpdateScript(280);
        assertTrue(imeOnly.contains("r.style.setProperty('--ime-bottom','280px')"));
        assertTrue(imeOnly.contains("new CustomEvent('pibot:ime-change',{detail:{imeBottom:280}})"));
        assertFalse(imeOnly.contains("localStorage"));
        assertFalse(imeOnly.contains("safe-area-inset"));
        assertFalse(imeOnly.contains("pibot:insets-ready"));
    }

    @Test
    public void filtersAllowedOriginsAndInjectableUrls() {
        assertTrue(WebViewInsetsState.ALLOWED_ORIGINS.contains("https://tauri.localhost"));
        assertTrue(WebViewInsetsState.ALLOWED_ORIGINS.contains("http://tauri.localhost"));
        assertFalse(WebViewInsetsState.isInjectablePageUrl(null));
        assertFalse(WebViewInsetsState.isInjectablePageUrl(""));
        assertFalse(WebViewInsetsState.isInjectablePageUrl("about:blank"));
        assertTrue(WebViewInsetsState.isInjectablePageUrl("https://tauri.localhost/index.html"));
    }
}
