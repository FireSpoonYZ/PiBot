package com.ai.assistance.shower;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.util.SparseArray;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.List;
import java.util.function.BooleanSupplier;

/** Private, bounded UiAutomation connection: no clipboard, tree output or text readback. */
final class SecretInputController {
    private SecretInputController() { }

    static synchronized int setText(int displayId, int x, int y, String text,
            BooleanSupplier cancelled) {
        if (displayId <= 0 || cancelled.getAsBoolean()) return 3;
        HandlerThread thread = new HandlerThread("ShowerSecretInput");
        UiAutomation automation = null;
        AccessibilityNodeInfo node = null;
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

            long deadline = SystemClock.uptimeMillis() + 3000;
            do {
                if (cancelled.getAsBoolean()) return 3;
                SparseArray<List<AccessibilityWindowInfo>> all = automation.getWindowsOnAllDisplays();
                try {
                    AccessibilityWindowInfo window = topWindow(all.get(displayId), displayId, x, y);
                    if (window != null) {
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
            if (node == null) return 1;
            if (cancelled.getAsBoolean()) return 3;
            if (!node.refresh() || !matches(node, x, y)) return 2;
            if (!node.isFocused() && !node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)) return 2;
            if (!node.refresh() || !node.isFocused() || !matches(node, x, y)) return 2;
            SparseArray<List<AccessibilityWindowInfo>> current = automation.getWindowsOnAllDisplays();
            try {
                AccessibilityWindowInfo window = topWindow(current.get(displayId), displayId, x, y);
                if (window == null || window.getId() != node.getWindowId()) return 2;
            } finally {
                recycleWindows(current);
            }
            if (cancelled.getAsBoolean()) return 3;
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            boolean applied;
            try { applied = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args); }
            finally { args.clear(); }
            if (cancelled.getAsBoolean()) return 3;
            return applied ? 0 : 2;
        } catch (ReflectiveOperationException | LinkageError unsupported) {
            return 1;
        } catch (Throwable failure) {
            return 2;
        } finally {
            if (node != null) node.recycle();
            if (automation != null) {
                try { UiAutomation.class.getMethod("disconnect").invoke(automation); }
                catch (Throwable ignored) { }
            }
            thread.quitSafely();
        }
    }

    private static AccessibilityWindowInfo topWindow(List<AccessibilityWindowInfo> windows,
            int displayId, int x, int y) {
        AccessibilityWindowInfo top = null;
        if (windows == null) return null;
        Rect bounds = new Rect();
        for (AccessibilityWindowInfo window : windows) {
            if (window.getDisplayId() != displayId) continue;
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
        return bounds.contains(x, y) && node.isVisibleToUser() && node.isEnabled()
                && (node.isEditable() || node.isPassword())
                && node.getActionList().contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_TEXT);
    }

    private static void recycleWindows(SparseArray<List<AccessibilityWindowInfo>> all) {
        for (int i = 0; i < all.size(); i++) {
            for (AccessibilityWindowInfo window : all.valueAt(i)) window.recycle();
        }
    }
}
