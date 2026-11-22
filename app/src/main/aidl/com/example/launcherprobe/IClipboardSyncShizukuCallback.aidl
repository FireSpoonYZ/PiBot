package com.example.launcherprobe;

/**
 * Callback from the dedicated clipboard sync Shizuku UserService to the app process.
 * Carries only bounded notification signals — never arbitrary commands, URIs, or file paths.
 */
interface IClipboardSyncShizukuCallback {
    /**
     * Signals that the OS primary clipboard changed while the listener was armed.
     * The app controller revalidates its exact active-online epoch on its serial worker
     * before requesting a filtered read.
     */
    oneway void onPrimaryClipChanged() = 1;

    /**
     * Signals that the UserService listener stopped or became unavailable (e.g., OEM
     * revocation, security denial, or service teardown).
     */
    oneway void onListenerUnavailable() = 2;
}
