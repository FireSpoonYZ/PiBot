package com.example.launcherprobe;

import com.example.launcherprobe.IClipboardSyncShizukuCallback;

/**
 * Narrowly typed Shizuku UserService interface dedicated to Android background clipboard sync.
 * Strictly scoped to this app's calling UID and limited to registering/unregistering a clipboard
 * change listener and reading already-filtered plain text (<= 64 KiB UTF-8). Exposes no package
 * management, shell execution, file I/O, URI dereferencing, clipboard writes, or arbitrary APIs.
 */
interface IClipboardSyncShizukuService {
    /**
     * Registers a clipboard change listener inside the shell/root UserService.
     * Returns true ONLY when the listener is actively registered and background clipboard
     * observation is supported for this runtime, profile, and user state. Never copies or
     * emits pre-existing clipboard contents on registration.
     */
    boolean startListening(IClipboardSyncShizukuCallback callback) = 1;

    /**
     * Unregisters any active clipboard change listener and detaches callback references.
     */
    void stopListening() = 2;

    /**
     * Reads the current primary clipboard ONLY if the listener is active, the device/user is
     * unlocked, the profile matches, the clip timestamp is strictly newer than the pre-online
     * baseline, and the clip passes {@code ClipboardSyncController} filtering: plain-text
     * representation only, no own/controlled-display clips or URI/Intent items, <= 64 KiB UTF-8.
     * Returns null otherwise.
     */
    String readFilteredPlainText() = 3;

    /**
     * Standard Shizuku UserService destroy transaction code.
     */
    void destroy() = 16777114;
}
