package com.example.launcherprobe;

import androidx.startup.InitializationProvider;

/**
 * M18 {@code :tauri_ui} 进程的 lifecycle-only 启动入口（空子类，不重写 final onCreate）。
 *
 * WryActivity 只在 ProcessLifecycleOwner 首次 ON_CREATE 时通知 Rust 创建 UI；合并清单里的默认
 * InitializationProvider 只运行在默认进程，:tauri_ui 从不提前初始化 ProcessLifecycleOwner，
 * 冷启动因此只有空白首帧。独立 authority + {@code :tauri_ui} 进程 + 只声明
 * ProcessLifecycleInitializer，让本进程在首个 Activity 之前初始化框架 lifecycle；
 * 不启动 Host/FGS/Node，也不改动默认进程与其 provider。
 */
public final class TauriInitializationProvider extends InitializationProvider {
}
