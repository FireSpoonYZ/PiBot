package com.example.launcherprobe;

import android.content.Context;

import org.json.JSONObject;

import java.util.Set;
import java.util.function.BooleanSupplier;

/**
 * Android Bot 内置浏览器的私有原生工具适配层（仅由 BotHostNativeTools 的 "bot_browser" 分发进入）。
 * 归属键严格来自可信调用上下文 (deviceId, botId)，不接受模型自报归属或越权动作；
 * 已分类失败通过 Failure 保留 BROWSER_* 协议错误码，绝不回传任意页面正文或凭据。
 */
final class BotBrowserBridge {
    private static final Set<String> ACTIONS = Set.of(
            "status", "open", "navigate", "back", "forward", "reload",
            "select", "closeTab", "frame", "snapshot", "act", "input", "release", "nativeGrant", "nativeRevoke"
    );
    private static final Set<String> SOURCES = Set.of("agent", "human");

    private final BotBrowserManager manager;

    BotBrowserBridge(Context context) {
        this(new BotBrowserManager(context));
    }

    BotBrowserBridge(BotBrowserManager manager) {
        this.manager = manager;
    }

    /** 执行一次 bot_browser 私有原生调用。 */
    JSONObject execute(JSONObject context, JSONObject arguments, BooleanSupplier cancelled)
            throws Exception {
        try {
            return run(context, arguments, cancelled);
        } catch (Failure failure) {
            throw failure;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new Failure("CANCELLED", "浏览器操作已中断", OUTCOME_NOT_SENT);
        } catch (IllegalArgumentException invalid) {
            throw new Failure("INVALID_ARGUMENT", "bot_browser 参数无效", OUTCOME_NOT_SENT);
        } catch (Exception other) {
            throw new Failure("BROWSER_BACKEND_FAILED", "Android Bot 浏览器操作失败");
        }
    }

    private JSONObject run(JSONObject context, JSONObject arguments, BooleanSupplier cancelled)
            throws Exception {
        if (cancelled != null && cancelled.getAsBoolean()) {
            throw new Failure("CANCELLED", "浏览器操作已取消", OUTCOME_NOT_SENT);
        }
        if (Thread.currentThread().isInterrupted()) {
            throw new Failure("CANCELLED", "浏览器操作已中断", OUTCOME_NOT_SENT);
        }
        if (context == null) {
            throw new IllegalArgumentException("缺少调用上下文");
        }
        if (arguments == null) {
            throw new IllegalArgumentException("缺少 bot_browser 参数");
        }
        String action = arguments.optString("action", "");
        if (!ACTIONS.contains(action)) {
            throw new IllegalArgumentException("未知 bot_browser action");
        }
        String source = arguments.optString("source", "");
        if (!SOURCES.contains(source)) {
            throw new IllegalArgumentException("bot_browser 只接受可信 source");
        }
        String deviceId = context.optString("deviceId", "");
        String botId = context.optString("botId", "");
        if (deviceId.isEmpty() || botId.isEmpty()) {
            throw new IllegalArgumentException("缺少可信 deviceId/botId");
        }

        return switch (action) {
            case "nativeGrant", "nativeRevoke" -> {
                if (!"human".equals(source) || !BotHostNativeTools.isHumanTaskId(context.opt("taskId"))) {
                    throw new Failure("INVALID_ARGUMENT", "Native presentation requires a human lease");
                }
                yield manager.nativePresentation(deviceId, botId, action, arguments);
            }
            case "status" -> manager.status(deviceId, botId, source, cancelled);
            case "open" -> manager.open(deviceId, botId, source, arguments, cancelled);
            case "navigate" -> manager.navigate(deviceId, botId, source, arguments, cancelled);
            case "back" -> manager.history(deviceId, botId, source, arguments, -1, cancelled);
            case "forward" -> manager.history(deviceId, botId, source, arguments, 1, cancelled);
            case "reload" -> manager.reload(deviceId, botId, source, arguments, cancelled);
            case "select" -> manager.select(deviceId, botId, source, arguments, cancelled);
            case "closeTab" -> manager.closeTab(deviceId, botId, source, arguments, cancelled);
            case "frame" -> manager.frame(deviceId, botId, source, arguments, cancelled);
            case "snapshot" -> manager.snapshot(deviceId, botId, source, arguments, cancelled);
            case "act" -> manager.act(deviceId, botId, source, arguments, cancelled);
            case "input" -> {
                if (!"human".equals(source)) {
                    throw new Failure("INVALID_ARGUMENT", "原始输入仅允许人类接管通道调用");
                }
                yield manager.input(deviceId, botId, arguments, cancelled);
            }
            case "release" -> manager.release(deviceId, botId, cancelled);
            default -> throw new IllegalArgumentException("未知 bot_browser action");
        };
    }

    /** Host 代际关闭时销毁本代全部 Bot 浏览器 WebView 与状态。 */
    void shutdown() {
        manager.shutdown();
    }

    static final String OUTCOME_NOT_SENT = "not-sent";
    static final String OUTCOME_UNCONFIRMED = "unconfirmed";
    static final String OUTCOME_RESPONDED = "responded";

    /** 带固定协议错误码的受控失败，由 BotHostNativeTools 透传到 native_result.error。 */
    static final class Failure extends Exception {
        final String code;
        final String outcome;

        Failure(String code, String message) {
            this(code, message, "ANDROID_NATIVE_UNCONFIRMED".equals(code)
                    ? OUTCOME_UNCONFIRMED
                    : OUTCOME_RESPONDED);
        }

        Failure(String code, String message, String outcome) {
            super(message);
            this.code = code;
            this.outcome = outcome;
        }

        boolean isUnconfirmed() {
            return OUTCOME_UNCONFIRMED.equals(outcome)
                    || "ANDROID_NATIVE_UNCONFIRMED".equals(code);
        }

        boolean isNotSent() {
            return OUTCOME_NOT_SENT.equals(outcome);
        }
    }
}
