package com.example.launcherprobe

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

private const val MICROPHONE = "microphone"
private const val STREAM_CLOSED_CODE = "EVENT_STREAM_CLOSED"
private const val STREAM_CLOSED_MESSAGE = "事件流已关闭，请重新连接"
// 私有终帧事件名（仅 Kotlin→Rust proxy→JS 内部消费）；公开 listener 仍是 hostFrame/voiceEvent。
private const val STREAM_ERROR_EVENT = "streamError"
private const val MAX_FRAMES = 8
private const val MAX_BYTES = 80L * 1024 * 1024

@InvokeArg
internal class ListenArgs {
    lateinit var onEvent: Channel
}

@InvokeArg
internal class AckArgs {
    lateinit var deliveryId: String
}

/**
 * M18 Tauri 界面的 Host 桥插件（运行在 :tauri_ui 进程）。
 * 只转发既有 Host 数据操作；UI 本地动作限于 start/stop/openSystemSettings/reconnect/hide，
 * 界面启动时由客户端前台生命周期管理 Host；不重放 mutation，事件按单 ACK 窗口有界投递。
 *
 * 四个 JS 命令与内部 eventsFailed 一律 resolve NativeReply：{ok:true,result} 或
 * {ok:false,error:{code,message,outcome}}，让 Rust 侧还原精确的 native 结果/outcome
 * （SDK 的 ErrorResponse 会丢弃 reject data）。
 */
@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = MICROPHONE)])
class BotHostTauriPlugin(private val hostActivity: Activity) : Plugin(hostActivity) {

    private class Frame(val deliveryId: String, val payload: JSObject, val bytes: Long)

    private class StreamFailure(val code: String, val outcome: String, val message: String)

    private val main = Handler(Looper.getMainLooper())
    private val streamOwner: String = UUID.randomUUID().toString()
    /** volatile：配对 worker 线程在登记提交点之前以此判定 UI 会话存活。 */
    @Volatile private var destroyed = false
    private var mainWebView: WebView? = null
    private var client: BotHostUiBridgeClient? = null
    private var events: Channel? = null
    private var streamId: String = ""
    private var generation = 0
    private var sequence = 0
    private var listening = false
    private val queue = ArrayDeque<Frame>()
    private var inFlight: Frame? = null
    private var pendingBytes = 0L
    private var streamFailure: StreamFailure? = null
    private var failedDeliveryId: String? = null
    private var reconnectEpoch = 0
    private var failureEpoch = 0
    private var pendingVoiceInvoke: Invoke? = null
    private var pendingVoiceParams: JSONObject? = null
    private var pendingVoiceGeneration = 0
    private var pendingVoiceGranted = false
    /** C7 配对的串行 worker：HTTP/设置子进程/桥调用都阻塞型，单线程保证不并发注册。 */
    private val pairWorker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "bot-center-pair").apply { isDaemon = true }
    }
    /** pair/repair 同时只允许一个在途（防并发注册）；超时的僵尸任务继续持有直到自然结束。 */
    private val pairInFlight = AtomicBoolean()
    /** Bot 屏幕原生覆盖层（懒创建）；只观看/接管已有屏幕，与 Host 事件流无关。 */
    private var screenOverlay: BotScreenOverlay? = null
    /** 系统选图/拍照：同进程序列化在 BotImagePicker 内（单会话）。 */
    private var imagePicker: BotImagePicker? = null

    override fun load(webView: WebView) {
        mainWebView = webView
    }

    // ---------- 命令：request / listen / ack / unlisten / eventsFailed ----------

    @Command
    fun request(invoke: Invoke) {
        val args = invoke.getArgs()
        val method = args.getString("method", null)
        if (method.isNullOrEmpty()) {
            replyInvalid(invoke, "INVALID_ARGS", "method is required")
            return
        }
        val rawParams = args.opt("params")
        val params: JSONObject?
        if (rawParams == null || rawParams === JSONObject.NULL) {
            params = JSONObject()
        } else {
            params = rawParams as? JSONObject
        }
        if (params == null) {
            replyInvalid(invoke, "INVALID_ARGS", "params 无效")
            return
        }
        onMain(invoke) { dispatch(invoke, method, params) }
    }

    @Command
    fun listen(invoke: Invoke) {
        val channel = try {
            invoke.parseArgs(ListenArgs::class.java).onEvent
        } catch (t: Throwable) {
            replyInvalid(invoke, "INVALID_ARGS", "onEvent 无效")
            return
        }
        onMain(invoke) {
            val failure = streamFailure
            if (failure != null) {
                // listen 不偷偷重连：失败后只接受显式 reconnect。
                replyStreamClosed(invoke, failure)
                return@onMain
            }
            if (!uiReady()) {
                replyInvalid(invoke, "NOT_READY", "界面未就绪")
                return@onMain
            }
            // 替换订阅：先关掉本 UI 自己的观察/捕获，再开新流（不动 Host/Agent）。
            if (events != null || listening) client?.pause()
            resetStream()
            streamId = streamOwner + ":" + generation
            events = channel
            listening = true
            replyOk(invoke, objectOf("listening" to true, "streamId" to streamId))
        }
    }

    @Command
    fun ack(invoke: Invoke) {
        val deliveryId = try {
            invoke.parseArgs(AckArgs::class.java).deliveryId
        } catch (t: Throwable) {
            replyInvalid(invoke, "INVALID_ARGS", "deliveryId 无效")
            return
        }
        onMain(invoke) {
            val failure = streamFailure
            if (failure != null && deliveryId == failedDeliveryId) {
                // 让前端获知失败；同一 id 的后续重复 ACK 只得到 acknowledged=false。
                failedDeliveryId = null
                replyStreamClosed(invoke, failure)
                return@onMain
            }
            val frame = inFlight
            val acknowledged = frame != null && frame.deliveryId == deliveryId
            if (acknowledged && frame != null) {
                inFlight = null
                pendingBytes -= frame.bytes
                val channel = events
                if (channel != null) drain(channel)
            }
            replyOk(invoke, objectOf("acknowledged" to acknowledged))
        }
    }

    @Command
    fun unlisten(invoke: Invoke) {
        onMain(invoke) {
            // 幂等清理本 UI 订阅与捕获；不清 latch，也不 stopHost（latched 时也必须 resolve）。
            resetStream()
            client?.pause()
            replyOk(invoke, JSObject())
        }
    }

    /** Rust 代理 Channel 在前端投递失败时回调；只让匹配的当前在途帧失败，过期 id 无害。 */
    @Command
    fun eventsFailed(invoke: Invoke) {
        val deliveryId = try {
            invoke.parseArgs(AckArgs::class.java).deliveryId
        } catch (t: Throwable) {
            replyInvalid(invoke, "INVALID_ARGS", "deliveryId 无效")
            return
        }
        onMain(invoke) {
            val frame = inFlight
            val failed = frame != null && frame.deliveryId == deliveryId
            if (failed) failStream()
            replyOk(invoke, objectOf("failed" to failed))
        }
    }

    // ---------- 分派 ----------

    private fun dispatch(invoke: Invoke, method: String, params: JSONObject) {
        when (method) {
            "start" -> startHost(invoke)
            "stop" -> stopHost(invoke)
            "hide" -> hide(invoke)
            "openSystemSettings" -> openSystemSettings(invoke)
            "openCenter" -> openCenter(invoke, params)
            "reconnect" -> reconnect(invoke)
            "clientLaunchTarget" -> {
                val target = (hostActivity as? TauriMainActivity)?.takeClientLaunchTarget()
                val reply = JSObject()
                reply.put("ok", true)
                reply.put("result", target ?: JSONObject.NULL)
                send(invoke, reply)
            }
            "pickImages" -> pickImages(invoke, params)
            "screenOpen" -> screenOpen(invoke, params)
            "screenLayout" -> screenLayout(invoke, params)
            "screenStatus" -> {
                val overlay = screenOverlay
                replyOk(invoke, if (overlay != null && overlay.isSession(screenSession(params))) overlay.status() else idleScreen())
            }
            "screenTakeover" -> screenTakeover(invoke, params)
            "screenClose" -> {
                val overlay = screenOverlay
                // 只关闭同一会话：过期页面的迟到 close 不影响新打开的画面。
                if (overlay != null && overlay.isSession(screenSession(params))) overlay.close()
                replyOk(invoke, idleScreen())
            }
            "pairCenter" -> pairCenter(invoke, params)
            "repairCenterBinding" -> repairCenterBinding(invoke)
            "onboardingStatus" -> onboardingStatus(invoke)
            "onboardingAction" -> onboardingAction(invoke, params)
            else -> dispatchService(invoke, method, params)
        }
    }

    private fun dispatchService(invoke: Invoke, method: String, params: JSONObject) {
        if (method !in SERVICE_METHODS) {
            replyInvalid(invoke, "INVALID_ARGS", "不支持的方法：" + method)
            return
        }
        val failure = streamFailure
        if (failure != null) {
            replyStreamClosed(invoke, failure)
            return
        }
        if (!uiReady()) {
            replyInvalid(invoke, "NOT_READY", "界面未就绪")
            return
        }
        if (method == "clientRequest" && params.optString("op") == "center_connect" && foregroundUi()
            && android.os.Build.VERSION.SDK_INT >= 33
            && hostActivity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            hostActivity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 3110)
        }
        if ("startVoice" == method) {
            startVoice(invoke, params)
            return
        }
        if (method == "clientChatVisibility" && params.optBoolean("visible") && !foregroundUi()) {
            params.put("visible", false)
        }
        if ("cancelVoice" == method) invalidatePendingVoice()
        if (method == "updateInstall") {
            if (!foregroundUi()) {
                replyInvalid(invoke, "NOT_FOREGROUND", "仅可在前台安装更新")
                return
            }
            forwardUpdateInstall(invoke, params)
            return
        }
        forward(invoke, method, params)
    }

    /**
     * updateInstall 显式入口：仅当返回状态为 waiting-permission 时打开本应用
     * "安装未知应用"系统设置页。只在用户显式点击触发；status 轮询不弹此页，
     * 用户授权后回到前台由用户再次点击继续安装。
     */
    private fun forwardUpdateInstall(invoke: Invoke, params: JSONObject) {
        val future = try {
            bridge().request("updateInstall", params)
        } catch (t: Throwable) {
            replyFailure(invoke, t)
            return
        }
        future.whenComplete { result, error ->
            main.post {
                if (error != null) {
                    replyFailure(invoke, error)
                    return@post
                }
                if (result != null && "waiting-permission" == result.optString("phase") && foregroundUi()) {
                    try {
                        hostActivity.startActivity(Intent(
                            android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            android.net.Uri.parse("package:" + hostActivity.packageName)))
                    } catch (t: Throwable) {
                        replyFailure(invoke, t)
                        return@post
                    }
                }
                replyOk(invoke, result)
            }
        }
    }

    // ---------- UI 本地动作 ----------

    private fun startHost(invoke: Invoke) {
        if (!foregroundUi()) {
            replyInvalid(invoke, "NOT_FOREGROUND", "仅可在前台启动 AI Host")
            return
        }
        try {
            BotHostService.startFromActivity(hostActivity)
            replyOk(invoke, objectOf("requested" to true))
        } catch (t: Throwable) {
            replyFailure(invoke, t)
        }
    }

    private fun stopHost(invoke: Invoke) {
        try {
            BotHostService.stopFromUser(hostActivity)
            replyOk(invoke, objectOf("requested" to true))
        } catch (t: Throwable) {
            replyFailure(invoke, t)
        }
    }

    private fun hide(invoke: Invoke) {
        try {
            // 只把任务移到后台：不关闭 Host、不销毁 WebView 状态。
            hostActivity.moveTaskToBack(true)
            replyOk(invoke, JSObject())
        } catch (t: Throwable) {
            replyFailure(invoke, t)
        }
    }

    private fun openCenter(invoke: Invoke, params: JSONObject) {
        val uri = android.net.Uri.parse(params.optString("url"))
        if (uri.scheme != "https" || uri.host.isNullOrEmpty() || uri.userInfo != null) {
            replyInvalid(invoke, "INVALID_ARGS", "中心地址必须是 HTTPS")
            return
        }
        try {
            hostActivity.startActivity(Intent(Intent.ACTION_VIEW, uri))
            replyOk(invoke, JSObject())
        } catch (t: Throwable) {
            replyFailure(invoke, t)
        }
    }

    private fun openSystemSettings(invoke: Invoke) {
        try {
            hostActivity.startActivity(Intent(android.provider.Settings.ACTION_SETTINGS))
            replyOk(invoke, JSObject())
        } catch (t: Throwable) {
            replyFailure(invoke, t)
        }
    }

    /**
     * C7 配对（UI 本地入口）：整链阻塞在 pairWorker 串行执行——参数校验/已有绑定检查、
     * snapshot 或 settingsGet 取本机 Host 身份、所有者会话四步 + POST /api/devices、
     * 断连清旧态 → 凭据/saveCenterSettings 持久化 → center_connect 派发。
     * 结果 {centerUrl,deviceId,displayName,hostConfigured,connectionRequested,warnings?}，绝不回传令牌/口令。
     */
    private fun pairCenter(invoke: Invoke, params: JSONObject) {
        runPairTask(invoke) { bridge ->
            CenterPairing.pair(hostActivity.applicationContext, bridge, params) { !destroyed }
        }
    }

    /** C7 绑定修复：用已存 client 凭据重发 saveCenterSettings+center_connect，不注册新设备。 */
    private fun repairCenterBinding(invoke: Invoke) {
        runPairTask(invoke) { bridge ->
            CenterPairing.repair(hostActivity.applicationContext, bridge)
        }
    }

    /**
     * pair/repair 共享派发：BUSY 拒绝并发（不排队无限等待）；worker 中结果经主线程回执；
     * 仅本通道有 360s 回执兜底——超时只回 TIMEOUT，worker 继续跑完持久化（不丢已登记凭据），
     * pairInFlight 也只在 worker 自然结束时释放。
     */
    private fun runPairTask(invoke: Invoke, work: (BotHostUiBridgeClient) -> JSONObject) {
        // 与通知 action 一致：开始即要求显式前台；提交后的持久化/连接仍允许完成。
        if (!foregroundUi()) {
            replyInvalid(invoke, "NOT_FOREGROUND", "仅可在前台执行配对")
            return
        }
        if (!pairInFlight.compareAndSet(false, true)) {
            replyInvalid(invoke, "BUSY", "配对任务进行中")
            return
        }
        val bridge = try {
            bridge()
        } catch (t: Throwable) {
            pairInFlight.set(false)
            replyFailure(invoke, t)
            return
        }
        val replied = AtomicBoolean()
        val timeout = Runnable {
            if (replied.compareAndSet(false, true)) {
                replyError(invoke, "TIMEOUT", "配对超时，请检查中心后重试", "unconfirmed")
            }
        }
        main.postDelayed(timeout, PAIR_REPLY_TIMEOUT_MS)
        pairWorker.execute {
            var result: JSONObject? = null
            var failure: Throwable? = null
            try {
                result = work(bridge)
            } catch (t: Throwable) {
                failure = t
            }
            val replyResult = result
            val replyError = failure
            main.post {
                main.removeCallbacks(timeout)
                if (replied.compareAndSet(false, true)) {
                    pairInFlight.set(false)
                    if (destroyed) replyInvalid(invoke, "CANCELLED", "界面已结束")
                    else if (replyError != null) replyFailure(invoke, replyError)
                    else replyOk(invoke, replyResult)
                } else {
                    pairInFlight.set(false)
                }
            }
        }
    }

    /** C7 引导状态（UI 本地只读）：通知/电池/Shizuku 五项，不启动任何服务。 */
    private fun onboardingStatus(invoke: Invoke) {
        try {
            replyOk(invoke, BotOnboarding.status(hostActivity.applicationContext))
        } catch (t: Throwable) {
            replyFailure(invoke, t)
        }
    }

    /** C7 引导动作（仅显式前台）：返回 {requested}，是否发出系统请求/页面。 */
    private fun onboardingAction(invoke: Invoke, params: JSONObject) {
        val action = params.opt("action") as? String
        if (action.isNullOrEmpty()) {
            replyInvalid(invoke, "INVALID_ARGS", "action 无效")
            return
        }
        if (!foregroundUi()) {
            replyInvalid(invoke, "NOT_FOREGROUND", "仅可在前台执行引导动作")
            return
        }
        try {
            replyOk(invoke, BotOnboarding.performAction(hostActivity, action))
        } catch (t: Throwable) {
            replyFailure(invoke, t)
        }
    }

    private fun reconnect(invoke: Invoke) {
        // 每次显式 reconnect 独占一代：只有最新一代的成功完成、且期间没有更新的 latch，才清失败。
        val epoch = ++reconnectEpoch
        val failureAtIssue = failureEpoch
        // 重连作废旧 stream 代：权限已授予但尚未开始的 pending 也不得在重连后偷偷开始。
        invalidatePendingVoice()
        val future = try {
            bridge().reconnect()
        } catch (t: Throwable) {
            replyFailure(invoke, t)
            return
        }
        future.whenComplete { result, error ->
            main.post {
                if (error != null) {
                    replyFailure(invoke, error)
                    return@post
                }
                // 并发/被更新的 reconnect 完成、或已完成 destroy，都不得清掉更新的失败。
                if (!destroyed && epoch == reconnectEpoch && failureEpoch == failureAtIssue) {
                    streamFailure = null
                    failedDeliveryId = null
                    discardFrames()
                    probeClientConnection()
                }
                replyOk(invoke, result)
            }
        }
    }

    // ---------- 语音：前台与麦克风权限校验（回调按 generation 归属） ----------

    private fun startVoice(invoke: Invoke, params: JSONObject) {
        if (!foregroundUi()) {
            replyInvalid(invoke, "NOT_FOREGROUND", "仅可在前台开始语音输入")
            return
        }
        if (!microphoneGranted()) {
            // 替换 pending 前先拒绝旧的权限请求，避免旧 Invoke 悬挂。
            invalidatePendingVoice()
            pendingVoiceInvoke = invoke
            pendingVoiceParams = params
            pendingVoiceGeneration = generation
            pendingVoiceGranted = false
            try {
                requestPermissionForAlias(MICROPHONE, invoke, "micPermission")
            } catch (t: Throwable) {
                clearPendingVoice()
                replyInvalid(invoke, "PERMISSION_FAILED", "无法请求麦克风权限")
            }
            return
        }
        forward(invoke, "startVoice", params)
    }

    @PermissionCallback
    private fun micPermission(invoke: Invoke) {
        // 权限弹窗只 pause 不 stop，且 activity result 先于 onResume：这里只记录“已授予”，
        // 真实前台判定留给 completePendingVoice（必要时由 onResume 补一轮），不再因暂停而取消。
        main.post {
            if (pendingVoiceInvoke !== invoke) return@post
            if (destroyed) {
                invalidatePendingVoice()
                return@post
            }
            if (!microphoneGranted()) {
                val call = pendingVoiceInvoke
                clearPendingVoice()
                if (call != null) replyInvalid(call, "PERMISSION_DENIED", "需要麦克风权限才能语音输入")
                return@post
            }
            pendingVoiceGranted = true
            completePendingVoice()
        }
    }

    /** 已授予的 pending 只在真实前台且未换代时才开始；否则保留 readiness，等下一轮 onResume。 */
    private fun completePendingVoice() {
        if (!pendingVoiceGranted) return
        val invoke = pendingVoiceInvoke ?: return
        val params = pendingVoiceParams
        if (destroyed || params == null || pendingVoiceGeneration != generation) {
            invalidatePendingVoice()
            return
        }
        if (!foregroundUi()) return
        clearPendingVoice()
        forward(invoke, "startVoice", params)
    }

    private fun microphoneGranted(): Boolean =
        hostActivity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** 取消/停止/重连/销毁/换代：显式 not-sent CANCELLED 拒绝尚未开始的权限等待。 */
    private fun invalidatePendingVoice() {
        val invoke = pendingVoiceInvoke
        clearPendingVoice()
        if (invoke != null) replyInvalid(invoke, "CANCELLED", "语音输入请求已取消")
    }

    private fun clearPendingVoice() {
        pendingVoiceInvoke = null
        pendingVoiceParams = null
        pendingVoiceGeneration = 0
        pendingVoiceGranted = false
    }

    // ---------- 桥客户端与事件投递 ----------

    private fun bridge(): BotHostUiBridgeClient {
        client?.let { return it }
        // destroyed 之后绝不再建桥/重绑：迟到的回调只能拿到已拒绝的 NativeReply。
        check(!destroyed) { "界面已结束" }
        val created = BotHostUiBridgeClient(hostActivity.applicationContext,
            object : BotHostUiBridgeClient.Listener {
                override fun onEvent(event: String, data: JSONObject) {
                    // 客户端已在读取线程侧有界准入并保证主线程回调：这里直接入队，不再逐帧 post。
                    if (Looper.myLooper() == Looper.getMainLooper()) deliver(event, data)
                    else main.post { deliver(event, data) }
                }

                override fun onClosed(error: BotHostProcess.BridgeException) {
                    if (Looper.myLooper() == Looper.getMainLooper()) onBridgeClosed(error)
                    else main.post { onBridgeClosed(error) }
                }
            })
        client = created
        return created
    }

    private fun onBridgeClosed(error: BotHostProcess.BridgeException) {
        if (destroyed || streamFailure != null) return
        // session 关闭：统一用私有 EVENT_STREAM_CLOSED latch 告知前端（不再透传 CLOSED/BUSY 等
        // session outcome，前端只在该 code 上收敛）；发生前已发出的 RPC 仍由各自回执保留精确 outcome。
        // 旧请求保留各自 outcome；重建只建立新会话，不重放请求。
        latchStream()
        scheduleBridgeRecovery(++reconnectEpoch)
    }

    private fun scheduleBridgeRecovery(epoch: Int) {
        main.postDelayed({
            if (destroyed || epoch != reconnectEpoch || streamFailure == null) return@postDelayed
            bridge().reconnect().whenComplete { _, error ->
                main.post {
                    if (destroyed || epoch != reconnectEpoch) return@post
                    if (error == null) {
                        streamFailure = null
                        failedDeliveryId = null
                        probeClientConnection()
                    } else scheduleBridgeRecovery(epoch)
                }
            }
        }, 1000)
    }

    private fun deliver(event: String, data: JSONObject) {
        if (destroyed || !listening || streamFailure != null) return
        val channel = events ?: return
        if (streamId.isEmpty()) return
        val deliveryId = streamId + ":" + sequence
        sequence++
        val payload = JSObject()
        payload.put("deliveryId", deliveryId)
        payload.put("event", event)
        payload.put("data", data)
        val bytes = payload.toString().toByteArray(Charsets.UTF_8).size.toLong()
        val live = queue.size + if (inFlight == null) 0 else 1
        if (bytes > MAX_BYTES || live >= MAX_FRAMES || pendingBytes + bytes > MAX_BYTES) {
            failStream()
            return
        }
        queue.add(Frame(deliveryId, payload, bytes))
        pendingBytes += bytes
        drain(channel)
    }

    /** 单一 ACK 窗口：同时只有一个在途帧；页面暂停时失效旧流。 */
    private fun drain(channel: Channel) {
        while (inFlight == null && queue.isNotEmpty()) {
            val frame = queue.poll() ?: return
            inFlight = frame
            try {
                channel.send(frame.payload)
            } catch (t: Throwable) {
                inFlight = null
                pendingBytes -= frame.bytes
                failStream()
                return
            }
        }
    }

    /** 事件流自身失败（溢出/Channel 投递失败/eventsFailed）：只停本 UI 观察/捕获，不动 Host。 */
    private fun failStream() {
        if (streamFailure != null) return
        latchStream()
        client?.pause()
        scheduleBridgeRecovery(++reconnectEpoch)
    }

    /**
     * UI 事件 latch：对外固定私有 code EVENT_STREAM_CLOSED + not-sent（前端只在此 code 上收敛）；
     * 在途 request/reconnect 的精确分项 outcome 由各自完成回执原样返回，这里不重写。
     *
     * 旧 channel 上发私有 streamError 终帧，通知前端作废旧代。
     */
    private fun latchStream() {
        // terminal 必须用旧 streamId 前缀 + 下一个 sequence，前端按代际准入后可忽略旧代终帧。
        val channel = events
        val terminal = if (channel != null && streamId.isNotEmpty()) terminalFrame() else null
        streamFailure = StreamFailure(STREAM_CLOSED_CODE, "not-sent", STREAM_CLOSED_MESSAGE)
        failureEpoch = reconnectEpoch
        failedDeliveryId = inFlight?.deliveryId ?: terminal?.deliveryId
        resetStream()
        if (terminal == null || channel == null) return
        try {
            // 终帧投递失败就结束：不重试、不重连、不循环；下次调用仍可在 NativeReply 上收敛。
            channel.send(terminal.payload)
        } catch (t: Throwable) {
            // 无日志：失败只体现在前端未收到终帧。
        }
    }

    /** 终帧：{deliveryId,event:'streamError',data:{code,message,outcome:'unconfirmed'}}，无 payload/凭据。 */
    private fun terminalFrame(): Frame {
        val deliveryId = streamId + ":" + sequence
        sequence++
        val payload = JSObject()
        payload.put("deliveryId", deliveryId)
        payload.put("event", STREAM_ERROR_EVENT)
        payload.put(
            "data",
            objectOf(
                "code" to STREAM_CLOSED_CODE,
                "message" to STREAM_CLOSED_MESSAGE,
                "outcome" to "unconfirmed"
            )
        )
        val bytes = payload.toString().toByteArray(Charsets.UTF_8).size.toLong()
        return Frame(deliveryId, payload, bytes)
    }

    private fun resetStream() {
        listening = false
        events = null
        streamId = ""
        discardFrames()
        sequence = 0
        generation++
        // 换代统一入口：立即作废尚未派发的权限等待，不等下一次权限回调才发现换代。
        // 已转发的 startVoice/RPC 回执与 outcome 不受影响。
        invalidatePendingVoice()
    }

    private fun discardFrames() {
        queue.clear()
        inFlight = null
        pendingBytes = 0
    }

    private fun forward(invoke: Invoke, method: String, params: JSONObject) {
        val future = try {
            bridge().request(method, params)
        } catch (t: Throwable) {
            replyFailure(invoke, t)
            return
        }
        future.whenComplete { result, error ->
            main.post {
                // 只回执客户端已给出的精确结果/错误；不触碰桥，也不会重绑。
                if (error != null) replyFailure(invoke, error) else replyOk(invoke, result)
            }
        }
    }

    // ---------- 系统选图/拍照（UI 本地动作，不经 Host 桥） ----------

    private fun pickImages(invoke: Invoke, params: JSONObject) {
        val source = params.optString("source")
        if (source != "photos" && source != "camera") {
            replyInvalid(invoke, "INVALID_ARGS", "source 必须是 photos 或 camera")
            return
        }
        if (!foregroundUi()) {
            replyInvalid(invoke, "NOT_FOREGROUND", "仅可在前台选择图片")
            return
        }
        val picker = imagePicker ?: BotImagePicker(hostActivity).also { imagePicker = it }
        val intent = try {
            picker.begin(source) { outcome ->
                // begin/deliver 在主线程同步回调、process 完成后 post 回主线程；两者都先记归属再回执，
                // 与 destroyed=true 后的同步收尾天然互斥（launch 后旧 invoke 已在 SDK 等待表中作废）。
                resolveImagePick(invoke, outcome)
            }
        } catch (e: BotImagePicker.PickerException) {
            replyInvalid(invoke, e.code, e.message ?: "无法打开图片选择")
            return
        }
        try {
            // SDK 官方管线：registerForActivityResult 由 PluginManager 持有，结果回到下方 @ActivityCallback。
            startActivityForResult(invoke, intent, "onPickImagesResult")
        } catch (t: Throwable) {
            picker.abort()
            replyInvalid(invoke, "NOT_AVAILABLE", "无法打开图片选择")
        }
    }

    /** 系统选择/相机 result 回调：分发到当前会话；已取消/销毁的旧会话分发无害。 */
    @ActivityCallback
    private fun onPickImagesResult(invoke: Invoke, result: ActivityResult) {
        onMain(invoke) { imagePicker?.deliver(result) }
    }

    private fun resolveImagePick(invoke: Invoke, outcome: BotImagePicker.Outcome) {
        when (outcome) {
            is BotImagePicker.Outcome.Images -> replyOk(invoke, objectOf("images" to outcome.images))
            is BotImagePicker.Outcome.Cancelled ->
                replyOk(invoke, objectOf("images" to org.json.JSONArray(), "cancelled" to true))
            is BotImagePicker.Outcome.Failed -> replyInvalid(invoke, outcome.code, outcome.message)
        }
    }

    // ---------- Bot 屏幕（UI 本地动作，不经 Host 桥） ----------

    private fun screenOpen(invoke: Invoke, params: JSONObject) {
        val botId = params.opt("botId") as? String
        if (botId.isNullOrEmpty() || botId.length > 256) {
            replyInvalid(invoke, "INVALID_ARGS", "botId 无效")
            return
        }
        if (!uiReady()) {
            replyInvalid(invoke, "NOT_READY", "界面未就绪")
            return
        }
        try {
            val overlay = screenOverlay ?: BotScreenOverlay(hostActivity) { mainWebView }.also { screenOverlay = it }
            overlay.open(botId)
            replyOk(invoke, overlay.status())
        } catch (t: Throwable) {
            replyFailure(invoke, t)
        }
    }

    private fun screenLayout(invoke: Invoke, params: JSONObject) {
        val overlay = screenOverlay
        if (overlay == null || !overlay.isSession(screenSession(params))) {
            replyOk(invoke, idleScreen())
            return
        }
        val x = params.optDouble("x", Double.NaN)
        val y = params.optDouble("y", Double.NaN)
        val width = params.optDouble("width", Double.NaN)
        val height = params.optDouble("height", Double.NaN)
        val dpr = params.optDouble("dpr", Double.NaN)
        val radius = params.optDouble("radius", 0.0)
        val visible = params.optBoolean("visible", false)
        val values = listOf(x, y, width, height, dpr, radius)
        if (values.any { it.isNaN() || it.isInfinite() } || dpr <= 0 || dpr > 8
            || width < 0 || height < 0 || width > 20000 || height > 20000) {
            replyInvalid(invoke, "INVALID_ARGS", "布局参数无效")
            return
        }
        overlay.layout(x, y, width, height, dpr, radius, visible)
        replyOk(invoke, overlay.status())
    }

    private fun screenTakeover(invoke: Invoke, params: JSONObject) {
        val overlay = screenOverlay
        if (overlay == null || !uiReady() || !overlay.isSession(screenSession(params))) {
            replyInvalid(invoke, "NOT_READY", "画面未连接")
            return
        }
        overlay.takeover { result, error ->
            main.post {
                if (error != null) replyFailure(invoke, error) else replyOk(invoke, result)
            }
        }
    }

    private fun screenSession(params: JSONObject): Int {
        val value = params.opt("session")
        return if (value is Number) value.toInt() else -1
    }

    private fun idleScreen(): JSObject = objectOf(
        "phase" to "idle", "live" to false, "userControl" to false,
        "width" to 1, "height" to 1, "platform" to "android-shower"
    )

    // ---------- 生命周期：只清理本 UI 资源 ----------

    override fun onPause(activity: AppCompatActivity) {
        if (destroyed) return
        main.post {
            // 取消本进程的观察/语音捕获；Host/Agent 与在途请求语义不变。
            if (!destroyed) {
                if (inFlight != null) {
                    failStream()
                } else client?.pause()
            }
        }
        // 离开前台即解绑 Bot 屏幕画面并结束接管；回到前台后按观看状态重连（需重新接管）。
        screenOverlay?.pause()
    }

    private fun probeClientConnection() {
        if (foregroundUi()) client?.request("clientConnectionProbe", JSONObject())
    }

    override fun onResume(activity: AppCompatActivity) {
        if (destroyed) return
        screenOverlay?.resume()
        // TauriMainActivity 在 super.onResume() 返回后才置 resumed=true。
        main.post {
            if (!destroyed) {
                probeClientConnection()
                if (pendingVoiceInvoke != null) completePendingVoice()
            }
        }
    }

    override fun onStop(activity: AppCompatActivity) {
        // 真实 stop（Home/离开）才作废 pending；权限弹窗本身只 pause 不 stop，故不在此列。
        // 只拒绝尚未开始的权限等待，已开始的捕获由 onPause + service lane 处理。
        if (destroyed) return
        if (pendingVoiceInvoke != null) invalidatePendingVoice()
    }

    override fun onDestroy(activity: AppCompatActivity) {
        // 同步 fence：SDK 随后即可能结束进程，清理不能只丢到主线程队列。
        destroyed = true
        invalidatePendingVoice()
        listening = false
        events = null
        streamId = ""
        discardFrames()
        streamFailure = null
        failedDeliveryId = null
        // destroyed 置位后同步收尾：CANCELLED NativeReply 在主线程立即发出，不遗留悬挂 Promise。
        imagePicker?.destroy()
        imagePicker = null
        screenOverlay?.destroy()
        screenOverlay = null
        pairWorker.shutdownNow()
        mainWebView = null
        val existing = client
        client = null
        existing?.close()
    }

    // ---------- 工具 ----------

    /** 延迟命令的统一入口：destroyed 后只回 NativeReply，不再触碰桥/流。 */
    private fun onMain(invoke: Invoke, body: () -> Unit) {
        main.post {
            if (destroyed) {
                replyInvalid(invoke, "CANCELLED", "界面已结束")
                return@post
            }
            body()
        }
    }

    private fun uiReady(): Boolean {
        val activity = hostActivity
        return mainWebView != null && activity is TauriMainActivity
            && !activity.isFinishing && !activity.isDestroyed
    }

    private fun foregroundUi(): Boolean {
        val activity = hostActivity
        return activity is TauriMainActivity && activity.isUiResumed()
            && !activity.isFinishing && !activity.isDestroyed
    }

    private fun objectOf(vararg pairs: Pair<String, Any?>): JSObject {
        val result = JSObject()
        for ((key, value) in pairs) result.put(key, value)
        return result
    }

    private fun replyOk(invoke: Invoke, result: JSONObject?) {
        val reply = JSObject()
        reply.put("ok", true)
        reply.put("result", result ?: JSObject())
        send(invoke, reply)
    }

    private fun replyStreamClosed(invoke: Invoke, failure: StreamFailure) {
        replyError(invoke, failure.code, failure.message, failure.outcome)
    }

    /** 已知的本地校验/分派前失败：尚未发送，outcome 固定 not-sent。 */
    private fun replyInvalid(invoke: Invoke, code: String, message: String) {
        replyError(invoke, code, message, "not-sent")
    }

    private fun replyError(invoke: Invoke, code: String, message: String, outcome: String) {
        val error = JSObject()
        error.put("code", code)
        error.put("message", message)
        error.put("outcome", outcome)
        val reply = JSObject()
        reply.put("ok", false)
        reply.put("error", error)
        send(invoke, reply)
    }

    private fun replyFailure(invoke: Invoke, failure: Throwable) {
        val cause = unwrap(failure)
        val bridge = cause as? BotHostProcess.BridgeException
        val code = bridge?.code
        val outcome = bridge?.outcome
        replyError(
            invoke,
            if (code.isNullOrEmpty()) "INTERNAL" else code,
            messageOf(cause),
            // 未知/JNI 回执失败保守 unconfirmed；BridgeException 的真实 outcome 原样透传。
            if (outcome.isNullOrEmpty()) "unconfirmed" else outcome
        )
    }

    private fun send(invoke: Invoke, reply: JSObject) {
        try {
            invoke.resolve(reply)
        } catch (t: Throwable) {
            // 最后兜底：NativeReply 自身无法回执时只能 reject，交由 Rust 保守归一。
            invoke.reject("操作失败")
        }
    }

    private fun messageOf(failure: Throwable): String {
        val message = failure.message
        if (message.isNullOrBlank()) return "操作失败"
        if (failure is BotHostProcess.BridgeException) {
            return if (message.length > 512) message.substring(0, 512) else message
        }
        if (failure is IllegalArgumentException || failure is IllegalStateException) return message
        return "操作失败"
    }

    private fun unwrap(failure: Throwable): Throwable {
        var current = failure
        while (current is CompletionException || current is ExecutionException) {
            val cause = current.cause ?: break
            if (cause === current) break
            current = cause
        }
        return current
    }

    private companion object {
        /** pair/repair 的 invoke 回执兜底（worker 持久化不受其影响）。 */
        const val PAIR_REPLY_TIMEOUT_MS = 360_000L

        /** 固定白名单：只有既有 Host 数据操作可转发；eventsFailed 是内部流控 helper，不在其中。 */
        val SERVICE_METHODS = setOf(
            "snapshot", "status", "centerSettings", "saveCenterSettings", "settingsGet", "settingsSet", "saveCredentials", "call",
            "observe", "cancelObservation", "voiceSettings", "saveVoiceSettings",
            "startVoice", "finishVoice", "cancelVoice", "uiSettings", "pause",
            // M20 客户端（远端 Host）固定入口；内层 broker 操作另有 16 项白名单。
            "clientRequest", "clientObserve", "clientUnobserve", "clientChatVisibility",
            // 客户端自更新：固定方法名直达默认进程 ClientUpdater。
            "updateStatus", "updateCheck", "updateDownload", "updateInstall", "updateCancel"
        )
    }
}
