package com.ai.assistance.shower.wrappers;

import android.graphics.Bitmap;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.IInterface;
import android.system.OsConstants;
import android.util.Log;

import java.lang.ref.Reference;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import java.util.function.ObjIntConsumer;

public final class WindowManager {

    public static final int DISPLAY_IME_POLICY_LOCAL = 0;
    public static final int DISPLAY_IME_POLICY_FALLBACK_DISPLAY = 1;
    public static final int DISPLAY_IME_POLICY_HIDE = 2;

    private static final String TAG = "ShowerWindowManager";
    private static final int CAPTURE_TIMEOUT_MS = 4000;

    private final IInterface manager;
    private Method setDisplayImePolicyMethod;

    private WindowManager(IInterface manager) {
        this.manager = manager;
    }

    public static WindowManager create() {
        IInterface manager = ServiceManager.getService("window", "android.view.IWindowManager");
        return new WindowManager(manager);
    }

    /** Captures on API 34+; the caller owns the returned software bitmap. */
    public Bitmap captureDisplay(int displayId, float frameScale)
            throws ReflectiveOperationException, InterruptedException {
        String screenCaptureClassName = Build.VERSION.SDK_INT >= 37
                ? "android.window.ScreenCaptureInternal" : "android.window.ScreenCapture";
        Class<?> screenCaptureClass = Class.forName(screenCaptureClassName);
        Class<?> captureArgsClass = Class.forName(screenCaptureClassName + "$CaptureArgs");
        Class<?> builderClass = Class.forName(screenCaptureClassName + "$CaptureArgs$Builder");
        Class<?> listenerClass = Class.forName(screenCaptureClassName + "$ScreenCaptureListener");
        Class<?> bufferClass = Class.forName(screenCaptureClassName + "$ScreenshotHardwareBuffer");
        Method getHardwareBuffer = bufferClass.getMethod("getHardwareBuffer");
        Method asBitmap = bufferClass.getMethod("asBitmap");

        Object builder = builderClass.getConstructor().newInstance();
        builderClass.getMethod("setFrameScale", float.class).invoke(builder, frameScale);
        if (Build.VERSION.SDK_INT >= 37) {
            // 0 is REDACT for both secure and protected content policies.
            builderClass.getMethod("setSecureContentPolicy", int.class).invoke(builder, 0);
            builderClass.getMethod("setProtectedContentPolicy", int.class).invoke(builder, 0);
        } else {
            builderClass.getMethod("setCaptureSecureLayers", boolean.class).invoke(builder, false);
            builderClass.getMethod("setAllowProtected", boolean.class).invoke(builder, false);
        }
        Object args = builderClass.getMethod("build").invoke(builder);
        CompletableFuture<Object> captured = new CompletableFuture<>();
        Consumer<Object> receiveBuffer = buffer -> captured.complete(buffer);
        ObjIntConsumer<Object> receiveResult = (buffer, status) -> {
            if (status == 0) {
                captured.complete(buffer);
            } else {
                closeScreenshot(buffer, getHardwareBuffer);
                Log.w(TAG, "Capture failed for display " + displayId + " with status " + status);
                captured.completeExceptionally(new CaptureException(
                        status == -OsConstants.EPERM || status == -OsConstants.EACCES
                                ? "SHOWER_CAPTURE_BLOCKED" : "SHOWER_CAPTURE_FAILED", status));
            }
        };
        boolean reportsStatus = Build.VERSION.SDK_INT >= 35;
        Object callback = reportsStatus ? receiveResult : receiveBuffer;
        Bitmap bitmap = null;
        Object listener = null;
        try {
            listener = listenerClass.getConstructor(
                    reportsStatus ? ObjIntConsumer.class : Consumer.class).newInstance(callback);
            manager.getClass().getMethod("captureDisplay", int.class, captureArgsClass, listenerClass)
                    .invoke(manager, displayId, args, listener);
            Object screenshot = captured.get(CAPTURE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (screenshot == null || getHardwareBuffer.invoke(screenshot) == null) {
                throw new CaptureException("SHOWER_CAPTURE_FAILED");
            }
            bitmap = (Bitmap) asBitmap.invoke(screenshot);
            if (bitmap == null) throw new CaptureException("SHOWER_CAPTURE_FAILED");
            Bitmap copy = bitmap.copy(Bitmap.Config.ARGB_8888, false);
            if (copy == null) throw new CaptureException("SHOWER_CAPTURE_FAILED");
            return copy;
        } catch (TimeoutException timeout) {
            throw new CaptureException("SHOWER_CAPTURE_TIMEOUT");
        } catch (ExecutionException failure) {
            throw (CaptureException) failure.getCause();
        } catch (InvocationTargetException failure) {
            if (failure.getCause() instanceof SecurityException) {
                throw new CaptureException("SHOWER_CAPTURE_BLOCKED");
            }
            throw failure;
        } finally {
            if (bitmap != null) bitmap.recycle();
            // Also close a buffer delivered after our bounded wait has expired.
            captured.thenAccept(buffer -> closeScreenshot(buffer, getHardwareBuffer));
            // The framework's native listener holds only a weak reference to its callback.
            Reference.reachabilityFence(callback);
            Reference.reachabilityFence(listener);
        }
    }

    public static final class CaptureException extends IllegalStateException {
        public final Integer status;

        private CaptureException(String code) {
            this(code, null);
        }

        private CaptureException(String code, Integer status) {
            super(code);
            this.status = status;
        }
    }

    private static void closeScreenshot(Object screenshot, Method getHardwareBuffer) {
        if (screenshot == null) return;
        try {
            HardwareBuffer buffer = (HardwareBuffer) getHardwareBuffer.invoke(screenshot);
            if (buffer != null) buffer.close();
        } catch (ReflectiveOperationException failure) {
            Log.w(TAG, "Unable to close screenshot buffer", failure);
        }
    }

    private Method getSetDisplayImePolicyMethod() throws NoSuchMethodException {
        if (setDisplayImePolicyMethod == null) {
            Class<?> cls = manager.getClass();
            if (Build.VERSION.SDK_INT >= 31) {
                setDisplayImePolicyMethod = cls.getMethod("setDisplayImePolicy", int.class, int.class);
            } else {
                setDisplayImePolicyMethod = cls.getMethod("setShouldShowIme", int.class, boolean.class);
            }
        }
        return setDisplayImePolicyMethod;
    }

    public void setDisplayImePolicy(int displayId, int displayImePolicy) {
        if (displayId < 0) {
            return;
        }
        try {
            Method method = getSetDisplayImePolicyMethod();
            if (Build.VERSION.SDK_INT >= 31) {
                method.invoke(manager, displayId, displayImePolicy);
            } else if (displayImePolicy != DISPLAY_IME_POLICY_HIDE) {
                boolean shouldShowIme = displayImePolicy == DISPLAY_IME_POLICY_LOCAL;
                method.invoke(manager, displayId, shouldShowIme);
            } else {
                Log.w(TAG, "DISPLAY_IME_POLICY_HIDE is not supported before Android 12");
            }
        } catch (NoSuchMethodException e) {
            Log.e(TAG, "setDisplayImePolicy method not found", e);
        } catch (Exception e) {
            Log.e(TAG, "setDisplayImePolicy failed", e);
        }
    }
}
