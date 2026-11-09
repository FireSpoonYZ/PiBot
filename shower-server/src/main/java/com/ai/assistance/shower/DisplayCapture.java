package com.ai.assistance.shower;

import android.graphics.Bitmap;
import android.graphics.Rect;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.IBinder;
import android.view.Surface;

import com.ai.assistance.shower.device.DisplayInfo;
import com.ai.assistance.shower.device.Size;
import com.ai.assistance.shower.wrappers.ServiceManager;
import com.ai.assistance.shower.wrappers.SurfaceControl;
import com.ai.assistance.shower.wrappers.WindowManager;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/** Display capture adapted from Operit Shower, with bounded output scaling. */
final class DisplayCapture {
    private static final int IMAGE_WAIT_TIMEOUT_MS = 1500;
    private static final int IMAGE_WAIT_INTERVAL_MS = 20;

    private DisplayCapture() { }

    static byte[] captureDisplay(int displayId, int maxWidth, int maxHeight) {
        ImageReader reader = null;
        VirtualDisplay mirror = null;
        IBinder display = null;
        Image image = null;
        try {
            DisplayInfo info = ServiceManager.getDisplayManager().getDisplayInfo(displayId);
            if (info == null) throw new IllegalStateException("Display not found: " + displayId);
            Size input = info.getSize();
            double scale = Math.min(1d, Math.min(maxWidth / (double) input.getWidth(),
                    maxHeight / (double) input.getHeight()));
            if (Build.VERSION.SDK_INT >= 34) {
                Bitmap bitmap = ServiceManager.getWindowManager().captureDisplay(displayId, (float) scale);
                try {
                    return encodeBitmapToPng(bitmap);
                } finally {
                    bitmap.recycle();
                }
            }
            int width = Math.max(1, (int) Math.round(input.getWidth() * scale));
            int height = Math.max(1, (int) Math.round(input.getHeight() * scale));
            reader = ImageReader.newInstance(width, height, android.graphics.PixelFormat.RGBA_8888, 2);
            Surface surface = reader.getSurface();
            try {
                mirror = ServiceManager.getDisplayManager().createVirtualDisplay(
                        "ShowerScreenshot", width, height, displayId, surface);
            } catch (Exception first) {
                try {
                    display = createDisplay();
                    setDisplaySurface(display, surface, input.toRect(), new Rect(0, 0, width, height),
                            info.getLayerStack());
                } catch (Exception second) {
                    first.addSuppressed(second);
                    throw first;
                }
            }
            image = waitForImage(reader);
            if (image == null) throw new IllegalStateException("Screenshot timed out");
            return encodeImageToPng(image);
        } catch (WindowManager.CaptureException failure) {
            Main.logToFile("Display capture failed for " + displayId + ": " + failure.getMessage()
                    + ", native status=" + failure.status, null);
            throw failure;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Display capture interrupted", interrupted);
        } catch (Throwable throwable) {
            Main.logToFile("Display capture failed for " + displayId + ": " + throwable, throwable);
            throw new IllegalStateException("Unable to capture virtual display", throwable);
        } finally {
            if (image != null) image.close();
            if (display != null) try {
                SurfaceControl.destroyDisplay(display);
            } catch (Throwable ignored) { }
            if (mirror != null) try {
                mirror.release();
            } catch (Throwable ignored) { }
            if (reader != null) reader.close();
        }
    }

    private static IBinder createDisplay() throws Exception {
        boolean secure = Build.VERSION.SDK_INT < AndroidVersions.API_30_ANDROID_11
                || (Build.VERSION.SDK_INT == AndroidVersions.API_30_ANDROID_11
                && !"S".equals(Build.VERSION.CODENAME));
        return SurfaceControl.createDisplay("ShowerScreenshot", secure);
    }

    private static void setDisplaySurface(IBinder display, Surface surface, Rect source,
            Rect target, int layerStack) {
        SurfaceControl.openTransaction();
        try {
            SurfaceControl.setDisplaySurface(display, surface);
            SurfaceControl.setDisplayProjection(display, 0, source, target);
            SurfaceControl.setDisplayLayerStack(display, layerStack);
        } finally {
            SurfaceControl.closeTransaction();
        }
    }

    private static Image waitForImage(ImageReader reader) throws InterruptedException {
        for (int waited = 0; waited < IMAGE_WAIT_TIMEOUT_MS; waited += IMAGE_WAIT_INTERVAL_MS) {
            Image image = reader.acquireLatestImage();
            if (image != null) return image;
            Thread.sleep(IMAGE_WAIT_INTERVAL_MS);
        }
        return null;
    }

    private static byte[] encodeBitmapToPng(Bitmap bitmap) {
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output) || output.size() == 0) {
                throw new IllegalStateException("Screenshot encoding failed");
            }
            return output.toByteArray();
        } catch (Exception exception) {
            throw new IllegalStateException("PNG encoding failed", exception);
        }
    }

    private static byte[] encodeImageToPng(Image image) {
        Bitmap bitmap = null;
        Bitmap cropped = null;
        try {
            Image.Plane plane = image.getPlanes()[0];
            ByteBuffer buffer = plane.getBuffer();
            int width = image.getWidth();
            int height = image.getHeight();
            int paddedWidth = width + (plane.getRowStride() - plane.getPixelStride() * width)
                    / plane.getPixelStride();
            bitmap = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888);
            buffer.rewind();
            bitmap.copyPixelsFromBuffer(buffer);
            cropped = paddedWidth == width ? bitmap : Bitmap.createBitmap(bitmap, 0, 0, width, height);
            return encodeBitmapToPng(cropped);
        } catch (Exception exception) {
            throw new IllegalStateException("PNG encoding failed", exception);
        } finally {
            if (cropped != null && cropped != bitmap) cropped.recycle();
            if (bitmap != null) bitmap.recycle();
        }
    }
}
