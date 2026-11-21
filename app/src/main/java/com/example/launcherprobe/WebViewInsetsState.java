package com.example.launcherprobe;

import java.util.Arrays;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Pure state machine and JS payload builder for Android WebView safe-area &amp; IME CSS variables
 * ({@code --safe-area-inset-top}, {@code --safe-area-inset-bottom}, {@code --ime-bottom}).
 *
 * <p>Keeps {@code --safe-area-inset-bottom} anchored to navigation bar / cutout height even while
 * the IME is open, defers snapping {@code --ime-bottom} during active {@code WindowInsetsAnimation}
 * transitions so per-frame {@code onProgress} updates animate smoothly, and deduplicates redundant
 * JavaScript evaluations when rounded CSS px values have not changed.
 */
final class WebViewInsetsState {
    static final String STORAGE_KEY = "pibot.safe-area-insets.v1";
    static final Set<String> ALLOWED_ORIGINS = Collections.unmodifiableSet(
            new LinkedHashSet<>(Arrays.asList("https://tauri.localhost", "http://tauri.localhost")));

    static final class ApplyResult {
        final boolean shouldSyncFull;
        final boolean shouldSyncImeOnly;
        final boolean dispatchImeChange;
        final boolean shouldUpdateDocStart;
        final int safeTopCssPx;
        final int safeBottomCssPx;
        final int dispatchedImeBottomCssPx;
        final int settledImeBottomCssPx;

        ApplyResult(
                boolean shouldSyncFull,
                boolean shouldSyncImeOnly,
                boolean dispatchImeChange,
                boolean shouldUpdateDocStart,
                int safeTopCssPx,
                int safeBottomCssPx,
                int dispatchedImeBottomCssPx,
                int settledImeBottomCssPx) {
            this.shouldSyncFull = shouldSyncFull;
            this.shouldSyncImeOnly = shouldSyncImeOnly;
            this.dispatchImeChange = dispatchImeChange;
            this.shouldUpdateDocStart = shouldUpdateDocStart;
            this.safeTopCssPx = safeTopCssPx;
            this.safeBottomCssPx = safeBottomCssPx;
            this.dispatchedImeBottomCssPx = dispatchedImeBottomCssPx;
            this.settledImeBottomCssPx = settledImeBottomCssPx;
        }
    }

    static final class ImeFrameResult {
        static final ImeFrameResult NO_CHANGE = new ImeFrameResult(false, false, 0, 0, 0);

        final boolean shouldDispatchIme;
        final boolean shouldUpdateDocStart;
        final int imeBottomCssPx;
        final int safeTopCssPx;
        final int safeBottomCssPx;

        ImeFrameResult(
                boolean shouldDispatchIme,
                boolean shouldUpdateDocStart,
                int imeBottomCssPx,
                int safeTopCssPx,
                int safeBottomCssPx) {
            this.shouldDispatchIme = shouldDispatchIme;
            this.shouldUpdateDocStart = shouldUpdateDocStart;
            this.imeBottomCssPx = imeBottomCssPx;
            this.safeTopCssPx = safeTopCssPx;
            this.safeBottomCssPx = safeBottomCssPx;
        }
    }

    static final class PageSyncResult {
        final int safeTopCssPx;
        final int safeBottomCssPx;
        final int imeBottomCssPx;
        final boolean dispatchImeChange;

        PageSyncResult(int safeTopCssPx, int safeBottomCssPx, int imeBottomCssPx, boolean dispatchImeChange) {
            this.safeTopCssPx = safeTopCssPx;
            this.safeBottomCssPx = safeBottomCssPx;
            this.imeBottomCssPx = imeBottomCssPx;
            this.dispatchImeChange = dispatchImeChange;
        }
    }

    private boolean hasInsets;
    private int safeTopCssPx;
    private int safeBottomCssPx;
    private int settledImeBottomCssPx;
    private int dispatchedImeBottomCssPx;
    private boolean hasDispatchedToCurrentPage;

    private boolean hasDocStartScript;
    private int docStartTopCssPx;
    private int docStartBottomCssPx;
    private int docStartImeCssPx;

    private final Set<Object> activeImeAnimations = Collections.newSetFromMap(new IdentityHashMap<>());

    static int pxToCssPx(int px, float density) {
        if (px <= 0) return 0;
        float safeDensity = density > 0f && Float.isFinite(density) ? density : 1f;
        return Math.round(px / safeDensity);
    }

    static boolean isInjectablePageUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        return !"about:blank".equals(url);
    }

    /**
     * Builds the document-start script injected via {@code WebViewCompat.addDocumentStartJavaScript}.
     * At {@code DidClearWindowObject}, {@code document.documentElement} is typically still {@code null},
     * so we immediately populate {@code localStorage} and observe {@code document} via
     * {@code MutationObserver} to apply CSS vars and clear first-install hidden visibility the instant
     * {@code <html>} is parsed (before first paint).
     */
    static String buildDocumentStartScript(int topCssPx, int bottomCssPx, int imeBottomCssPx) {
        int t = Math.max(0, topCssPx);
        int b = Math.max(0, bottomCssPx);
        int i = Math.max(0, imeBottomCssPx);
        return "(function(){"
                + "var t=" + t + ",b=" + b + ",i=" + i + ";"
                + "try{localStorage.setItem('" + STORAGE_KEY + "',JSON.stringify({top:t,bottom:b}));}catch(e){}"
                + "var done=false;"
                + "function apply(){"
                + "var r=document.documentElement;"
                + "if(!r||done)return false;"
                + "done=true;"
                + "var s=r.style;"
                + "s.setProperty('--safe-area-inset-top',t+'px');"
                + "s.setProperty('--safe-area-inset-bottom',b+'px');"
                + "s.setProperty('--ime-bottom',i+'px');"
                + "r.dataset.insetsReady='1';"
                + "s.visibility='';"
                + "window.dispatchEvent(new CustomEvent('pibot:insets-ready',{detail:{top:t,bottom:b,imeBottom:i}}));"
                + "return true;"
                + "}"
                + "if(!apply()){"
                + "var mo=null;"
                + "try{mo=new MutationObserver(function(){if(apply()&&mo)mo.disconnect();});mo.observe(document,{childList:true});}catch(e){}"
                + "document.addEventListener('DOMContentLoaded',function(){if(mo)mo.disconnect();apply();},{once:true});"
                + "}"
                + "})();";
    }

    /**
     * Builds the full insets sync script for {@code onApplyWindowInsets}, {@code onPageCommitVisible},
     * and {@code onPageFinished}. Persists safe-area values to {@code localStorage}, sets all three
     * CSS custom properties, marks {@code dataset.insetsReady = '1'}, clears {@code visibility},
     * dispatches {@code pibot:insets-ready}, and optionally dispatches {@code pibot:ime-change}.
     */
    static String buildInsetsSyncScript(
            int topCssPx, int bottomCssPx, int imeBottomCssPx, boolean dispatchImeChange) {
        int t = Math.max(0, topCssPx);
        int b = Math.max(0, bottomCssPx);
        int i = Math.max(0, imeBottomCssPx);
        StringBuilder sb = new StringBuilder(384);
        sb.append("(function(){")
                .append("var t=").append(t).append(",b=").append(b).append(",i=").append(i).append(';')
                .append("try{localStorage.setItem('").append(STORAGE_KEY)
                .append("',JSON.stringify({top:t,bottom:b}));}catch(e){}")
                .append("var r=document.documentElement;")
                .append("if(!r)return;")
                .append("var s=r.style;")
                .append("s.setProperty('--safe-area-inset-top',t+'px');")
                .append("s.setProperty('--safe-area-inset-bottom',b+'px');")
                .append("s.setProperty('--ime-bottom',i+'px');")
                .append("r.dataset.insetsReady='1';")
                .append("s.visibility='';")
                .append("window.dispatchEvent(new CustomEvent('pibot:insets-ready',{detail:{top:t,bottom:b,imeBottom:i}}));");
        if (dispatchImeChange) {
            sb.append("window.dispatchEvent(new CustomEvent('pibot:ime-change',{detail:{imeBottom:i}}));");
        }
        sb.append("})();");
        return sb.toString();
    }

    /**
     * Builds the lightweight per-frame IME update script for {@code WindowInsetsAnimationCompat.Callback}
     * {@code onProgress} / {@code onEnd}. Avoids touching {@code localStorage} or safe-area variables.
     */
    static String buildImeUpdateScript(int imeBottomCssPx) {
        int i = Math.max(0, imeBottomCssPx);
        return "(function(){"
                + "var r=document.documentElement;"
                + "if(!r)return;"
                + "r.style.setProperty('--ime-bottom','" + i + "px');"
                + "window.dispatchEvent(new CustomEvent('pibot:ime-change',{detail:{imeBottom:" + i + "}}));"
                + "})();";
    }

    boolean hasInsets() {
        return hasInsets;
    }

    boolean isImeAnimating() {
        return !activeImeAnimations.isEmpty();
    }

    int getSafeTopCssPx() {
        return safeTopCssPx;
    }

    int getSafeBottomCssPx() {
        return safeBottomCssPx;
    }

    int getSettledImeBottomCssPx() {
        return settledImeBottomCssPx;
    }

    int getDispatchedImeBottomCssPx() {
        return dispatchedImeBottomCssPx;
    }

    /**
     * Seeds initial insets prior to first {@code loadUrl} so {@code addDocumentStartJavaScript}
     * can inject real values before first paint. When {@code acceptZeroInsets} is {@code false}
     * (e.g. unattached {@code WindowMetrics} fallback), all-zero readings are ignored so we wait
     * for authoritative {@code onApplyWindowInsets} instead of revealing at {@code 0px}.
     */
    boolean seedInitialInsets(int topCssPx, int bottomCssPx, int imeBottomCssPx, boolean acceptZeroInsets) {
        if (hasInsets) return false;
        int nextTop = Math.max(0, topCssPx);
        int nextBottom = Math.max(0, bottomCssPx);
        int nextIme = Math.max(0, imeBottomCssPx);
        if (!acceptZeroInsets && nextTop == 0 && nextBottom == 0 && nextIme == 0) {
            return false;
        }
        hasInsets = true;
        safeTopCssPx = nextTop;
        safeBottomCssPx = nextBottom;
        settledImeBottomCssPx = nextIme;
        dispatchedImeBottomCssPx = nextIme;
        return true;
    }

    ApplyResult onApplyInsets(int topCssPx, int bottomCssPx, int imeBottomCssPx) {
        int nextTop = Math.max(0, topCssPx);
        int nextBottom = Math.max(0, bottomCssPx);
        int nextIme = Math.max(0, imeBottomCssPx);

        boolean firstDelivery = !hasInsets;
        boolean safeAreaChanged = firstDelivery || nextTop != safeTopCssPx || nextBottom != safeBottomCssPx;
        hasInsets = true;
        safeTopCssPx = nextTop;
        safeBottomCssPx = nextBottom;
        settledImeBottomCssPx = nextIme;

        if (!activeImeAnimations.isEmpty()) {
            // During an active IME animation, Android dispatches the target IME height in
            // onApplyWindowInsets right after onPrepare; defer snapping --ime-bottom so onProgress
            // animates smoothly without a 1-frame jump.
            boolean shouldSyncFull = safeAreaChanged || !hasDispatchedToCurrentPage;
            if (shouldSyncFull) {
                hasDispatchedToCurrentPage = true;
            }
            boolean shouldUpdateDocStart = safeAreaChanged
                    && needsDocStartUpdate(safeTopCssPx, safeBottomCssPx, settledImeBottomCssPx);
            return new ApplyResult(
                    shouldSyncFull,
                    false,
                    false,
                    shouldUpdateDocStart,
                    safeTopCssPx,
                    safeBottomCssPx,
                    dispatchedImeBottomCssPx,
                    settledImeBottomCssPx);
        }

        boolean imeChanged = nextIme != dispatchedImeBottomCssPx;
        dispatchedImeBottomCssPx = nextIme;

        boolean shouldUpdateDocStart = needsDocStartUpdate(safeTopCssPx, safeBottomCssPx, settledImeBottomCssPx);
        boolean shouldSyncFull = safeAreaChanged || !hasDispatchedToCurrentPage;
        boolean shouldSyncImeOnly = !shouldSyncFull && imeChanged;
        if (shouldSyncFull) {
            hasDispatchedToCurrentPage = true;
        }
        return new ApplyResult(
                shouldSyncFull,
                shouldSyncImeOnly,
                imeChanged,
                shouldUpdateDocStart,
                safeTopCssPx,
                safeBottomCssPx,
                dispatchedImeBottomCssPx,
                settledImeBottomCssPx);
    }

    void onImeAnimationPrepare(Object animationToken) {
        if (animationToken != null) {
            activeImeAnimations.add(animationToken);
        }
    }

    ImeFrameResult onImeAnimationProgress(int imeBottomCssPx) {
        int nextIme = Math.max(0, imeBottomCssPx);
        if (nextIme == dispatchedImeBottomCssPx) {
            return ImeFrameResult.NO_CHANGE;
        }
        dispatchedImeBottomCssPx = nextIme;
        return new ImeFrameResult(true, false, nextIme, safeTopCssPx, safeBottomCssPx);
    }

    ImeFrameResult onImeAnimationEnd(Object animationToken, Integer rootImeBottomCssPx) {
        if (animationToken != null) {
            activeImeAnimations.remove(animationToken);
        }
        if (!activeImeAnimations.isEmpty()) {
            return ImeFrameResult.NO_CHANGE;
        }
        int settled = rootImeBottomCssPx != null
                ? Math.max(0, rootImeBottomCssPx)
                : settledImeBottomCssPx;
        settledImeBottomCssPx = settled;
        boolean imeChanged = settled != dispatchedImeBottomCssPx;
        dispatchedImeBottomCssPx = settled;
        boolean shouldUpdateDocStart = hasInsets
                && needsDocStartUpdate(safeTopCssPx, safeBottomCssPx, settledImeBottomCssPx);
        if (!imeChanged && !shouldUpdateDocStart) {
            return ImeFrameResult.NO_CHANGE;
        }
        return new ImeFrameResult(imeChanged, shouldUpdateDocStart, settled, safeTopCssPx, safeBottomCssPx);
    }

    void onPageStarted() {
        hasDispatchedToCurrentPage = false;
    }

    PageSyncResult onPageReady() {
        if (!hasInsets) return null;
        hasDispatchedToCurrentPage = true;
        int currentIme = activeImeAnimations.isEmpty() ? settledImeBottomCssPx : dispatchedImeBottomCssPx;
        dispatchedImeBottomCssPx = currentIme;
        return new PageSyncResult(safeTopCssPx, safeBottomCssPx, currentIme, currentIme > 0);
    }

    void markDocStartRegistered(int topCssPx, int bottomCssPx, int imeBottomCssPx) {
        hasDocStartScript = true;
        docStartTopCssPx = Math.max(0, topCssPx);
        docStartBottomCssPx = Math.max(0, bottomCssPx);
        docStartImeCssPx = Math.max(0, imeBottomCssPx);
    }

    void resetForNewWebView() {
        hasDispatchedToCurrentPage = false;
        hasDocStartScript = false;
        activeImeAnimations.clear();
    }

    void clearAnimations() {
        activeImeAnimations.clear();
    }

    boolean needsDocStartUpdate() {
        return needsDocStartUpdate(safeTopCssPx, safeBottomCssPx, settledImeBottomCssPx);
    }

    private boolean needsDocStartUpdate(int topCssPx, int bottomCssPx, int imeBottomCssPx) {
        return !hasDocStartScript
                || docStartTopCssPx != topCssPx
                || docStartBottomCssPx != bottomCssPx
                || docStartImeCssPx != imeBottomCssPx;
    }
}
