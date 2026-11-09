package com.ai.assistance.shower;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.util.SparseArray;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.List;
import java.util.function.BooleanSupplier;

/** Private, bounded UiAutomation connection: no clipboard, tree output or text readback. */
final class SecretInputController {
    private SecretInputController() { }

    static synchronized int setText(int displayId, int x, int y, String text,
            InputController input, BooleanSupplier cancelled) {
        if (displayId <= 0 || cancelled.getAsBoolean()) return 3;
        HandlerThread thread = new HandlerThread("ShowerSecretInput");
        UiAutomation automation = null;
        AccessibilityNodeInfo node = null;
        String stage = "connect";
        try {
            thread.start();
            Object connection = Class.forName("android.app.UiAutomationConnection")
                    .getDeclaredConstructor().newInstance();
            java.lang.reflect.Constructor<UiAutomation> constructor = UiAutomation.class
                    .getDeclaredConstructor(Looper.class, Class.forName("android.app.IUiAutomationConnection"));
            constructor.setAccessible(true);
            automation = constructor.newInstance(thread.getLooper(), connection);
            // Never fall back to connect(): that would suppress the user's accessibility services.
            UiAutomation.class.getMethod("connect", int.class).invoke(automation,
                    UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            AccessibilityServiceInfo info = automation.getServiceInfo();
            if (info == null) return 1;
            info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            automation.setServiceInfo(info);

            stage = "target-search";
            long deadline = SystemClock.uptimeMillis() + 3000;
            do {
                if (cancelled.getAsBoolean()) return 3;
                SparseArray<List<AccessibilityWindowInfo>> all = automation.getWindowsOnAllDisplays();
                try {
                    AccessibilityWindowInfo window = topWindow(all.get(displayId), displayId, x, y, false);
                    if (window != null && window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION) {
                        AccessibilityNodeInfo root = window.getRoot();
                        if (root != null) {
                            try { node = find(root, x, y, 0, new int[] {4000}, cancelled); }
                            finally { root.recycle(); }
                        }
                    }
                } finally {
                    recycleWindows(all);
                }
                if (node != null) break;
                Thread.sleep(100);
            } while (SystemClock.uptimeMillis() < deadline);
            if (node == null) {
                Main.logToFile("Secret input unsupported at target-search on display " + displayId, null);
                return 1;
            }
            if (cancelled.getAsBoolean()) return 3;
            stage = "target-validation";
            if (!node.refresh() || !matches(node, x, y)) return failed(displayId, stage);
            int windowId = node.getWindowId();
            stage = "focus-request";
            // Authorize the write from refreshed focus state, not the action acknowledgement.
            if (!node.isFocused()) node.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            stage = "focus-and-layout";
            String failure = prepareTarget(automation, node, displayId, windowId, input, cancelled);
            if (cancelled.getAsBoolean()) return 3;
            if (failure != null) return failed(displayId, failure);
            stage = "set-text";
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            boolean applied;
            try { applied = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args); }
            finally { args.clear(); }
            if (cancelled.getAsBoolean()) return 3;
            return applied ? 0 : failed(displayId, "set-text-rejected");
        } catch (ReflectiveOperationException | LinkageError unsupported) {
            Main.logToFile("Secret input unsupported at " + stage + " on display " + displayId, null);
            return 1;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return 3;
        } catch (Throwable failure) {
            return failed(displayId, stage);
        } finally {
            if (node != null) node.recycle();
            if (automation != null) {
                try { UiAutomation.class.getMethod("disconnect").invoke(automation); }
                catch (Throwable ignored) { }
            }
            thread.quitSafely();
        }
    }

    private static int failed(int displayId, String stage) {
        // Fixed stages only: exceptions and nodes can contain the private input.
        Main.logToFile("Secret input failed at " + stage + " on display " + displayId, null);
        return 2;
    }

    private static String prepareTarget(UiAutomation automation, AccessibilityNodeInfo node,
            int displayId, int windowId, InputController input, BooleanSupplier cancelled)
            throws InterruptedException {
        long deadline = SystemClock.uptimeMillis() + 1500;
        Rect previousBounds = new Rect();
        Rect bounds = new Rect();
        boolean keyboardDismissed = false;
        String failure = "focus-timeout";
        do {
            if (cancelled.getAsBoolean()) return "cancelled";
            if (!node.refresh() || node.getWindowId() != windowId) return "target-lost";
            node.getBoundsInScreen(bounds);
            SparseArray<List<AccessibilityWindowInfo>> all = automation.getWindowsOnAllDisplays();
            try {
                List<AccessibilityWindowInfo> windows = all.get(displayId);
                boolean keyboardVisible = false;
                if (windows != null) {
                    for (AccessibilityWindowInfo window : windows) {
                        if (window.getDisplayId() == displayId
                                && window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
                            keyboardVisible = true;
                            break;
                        }
                    }
                }
                AccessibilityWindowInfo window = topWindow(windows, displayId,
                        bounds.centerX(), bounds.centerY(), keyboardVisible);
                boolean sameWindow = !bounds.isEmpty() && window != null && window.getId() == windowId
                        && window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION;
                if (node.isFocused() && sameWindow && keyboardVisible) {
                    if (!keyboardDismissed) {
                        if (cancelled.getAsBoolean()) return "cancelled";
                        keyboardDismissed = true;
                        if (!input.injectKeyWithMeta(KeyEvent.KEYCODE_BACK, 0)) {
                            return "keyboard-dismiss-rejected";
                        }
                    }
                    failure = "keyboard-timeout";
                    previousBounds.setEmpty();
                } else if (node.isFocused() && sameWindow && !keyboardVisible && writable(node)) {
                    // Focus can scroll the same node away from the original screenshot coordinates.
                    if (bounds.equals(previousBounds)) return null;
                    previousBounds.set(bounds);
                    failure = "layout-timeout";
                } else {
                    previousBounds.setEmpty();
                    failure = !sameWindow ? "target-obscured"
                            : node.isFocused() ? "target-not-writable" : "focus-timeout";
                }
            } finally {
                recycleWindows(all);
            }
            Thread.sleep(50);
        } while (SystemClock.uptimeMillis() < deadline);
        return failure;
    }

    private static AccessibilityWindowInfo topWindow(List<AccessibilityWindowInfo> windows,
            int displayId, int x, int y, boolean skipKeyboard) {
        AccessibilityWindowInfo top = null;
        if (windows == null) return null;
        Rect bounds = new Rect();
        for (AccessibilityWindowInfo window : windows) {
            if (window.getDisplayId() != displayId
                    || (skipKeyboard && window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD)) continue;
            window.getBoundsInScreen(bounds);
            if (bounds.contains(x, y) && (top == null || window.getLayer() > top.getLayer())) top = window;
        }
        return top;
    }

    private static AccessibilityNodeInfo find(AccessibilityNodeInfo node, int x, int y, int depth,
            int[] remaining, BooleanSupplier cancelled) {
        if (cancelled.getAsBoolean() || depth > 60 || --remaining[0] < 0) return null;
        for (int i = 0; i < node.getChildCount() && remaining[0] > 0 && !cancelled.getAsBoolean(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            try {
                AccessibilityNodeInfo found = find(child, x, y, depth + 1, remaining, cancelled);
                if (found != null) return found;
            } finally {
                child.recycle();
            }
        }
        return matches(node, x, y) ? AccessibilityNodeInfo.obtain(node) : null;
    }

    private static boolean matches(AccessibilityNodeInfo node, int x, int y) {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        return bounds.contains(x, y) && writable(node);
    }

    private static boolean writable(AccessibilityNodeInfo node) {
        return node.isVisibleToUser() && node.isEnabled()
                && (node.isEditable() || node.isPassword())
                && node.getActionList().contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_TEXT);
    }

    private static void recycleWindows(SparseArray<List<AccessibilityWindowInfo>> all) {
        for (int i = 0; i < all.size(); i++) {
            for (AccessibilityWindowInfo window : all.valueAt(i)) window.recycle();
        }
    }
}
