package com.example.launcherprobe;

/**
 * Package-private JNI bridge for the dedicated clipboard sync library
 * ({@code libpibot_clipboard_sync.so}), loaded in the default app process only.
 *
 * <p>Zero handles and zero generations are invalid. {@code caPem} is nullable.
 * {@link #generateGroupCode()} may return {@code null} on failure. All native
 * errors are redacted, and {@link #status(long)} only maps to
 * {@code connecting}, {@code online}, {@code offline}, {@code unauthorized},
 * {@code unsupported}, or {@code certificateError}.
 */
final class ClipboardSyncNative {
    static {
        System.loadLibrary("pibot_clipboard_sync");
    }

    private ClipboardSyncNative() {}

    /**
     * Callback invoked from the native relay runtime when a decrypted clip
     * arrives. Implementations must post only bounded work and recheck
     * {@link #onlineGeneration(long)} against {@code generation} before any
     * deferred OS clipboard write.
     */
    interface Receiver {
        void onText(long generation, String text);
    }

    static native String generateGroupCode();

    static native boolean validGroupCode(String code);

    static native long start(
            String origin,
            String deviceId,
            String token,
            String caPem,
            String code,
            Receiver receiver);

    static native String status(long handle);

    static native long onlineGeneration(long handle);

    static native boolean send(long handle, long generation, String text);

    static native void stop(long handle);
}
