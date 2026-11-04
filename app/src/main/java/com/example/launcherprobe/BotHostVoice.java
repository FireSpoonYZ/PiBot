package com.example.launcherprobe;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Host 语音门面：显式用户听写和朗读。
 * 所有公开入口 marshal 到主线程；唯一共享状态是当前捕获。speak 只保证已交给 SpeechOutput，不保证播放完成。
 */
final class BotHostVoice {
    interface InputListener {
        void onPartial(String text);

        void onResult(String botId, String requestId, String text);

        void onError(String message);
    }

    private static final String NS_VOICE = "bot_host_voice";
    private static final String NS_VOICE_SECRETS = "bot_host_voice_secrets";

    private final Context context;
    private final VoiceSettings settings;
    private final SpeechOutput output;
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
    private final AtomicInteger speakGeneration = new AtomicInteger();
    private final AtomicBoolean closed = new AtomicBoolean();
    private Capture capture;

    private static final class Capture {
        final String botId;
        final String requestId;
        final InputListener listener;
        final SpeechInput input;

        Capture(String botId, String requestId, InputListener listener, SpeechInput input) {
            this.botId = botId;
            this.requestId = requestId;
            this.listener = listener;
            this.input = input;
        }
    }

    private static final class RemoteEdit {
        final String baseUrl, model, voice, apiKey;

        RemoteEdit(String baseUrl, String model, String voice, String apiKey) {
            this.baseUrl = baseUrl; this.model = model; this.voice = voice; this.apiKey = apiKey;
        }
    }

    BotHostVoice(Context context) {
        this.context = context.getApplicationContext();
        settings = new VoiceSettings(this.context, NS_VOICE, NS_VOICE_SECRETS);
        output = new SpeechOutput(this.context, settings);
    }

    /** accepted true 仅在文本于主线程交给 SpeechOutput 之后返回；关闭/空文本为固定错误，交接前取消/被取代为 CancellationException。 */
    CompletableFuture<JSONObject> speak(String text) {
        if (closed.get()) return failed(new IOException("语音已关闭"));
        if (text == null || text.trim().isEmpty()) return failed(new IllegalArgumentException("朗读文本为空"));
        int token = speakGeneration.incrementAndGet();
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        main.post(() -> {
            if (closed.get()) { future.completeExceptionally(new IOException("语音已关闭")); return; }
            if (token != speakGeneration.get() || future.isCancelled()) {
                future.completeExceptionally(new CancellationException("朗读已取消"));
                return;
            }
            try {
                output.speak(text);
                future.complete(accepted(true));
            } catch (Exception failure) {
                future.completeExceptionally(new IOException("语音朗读失败"));
            }
        });
        return future;
    }

    void stopOutput() {
        speakGeneration.incrementAndGet();
        main.post(() -> { if (!closed.get()) output.stop(); });
    }

    void startInput(String botId, String requestId, InputListener listener) {
        if (listener == null) throw new IllegalArgumentException("listener 不能为空");
        if (botId == null || botId.trim().isEmpty()) throw new IllegalArgumentException("botId 不能为空");
        if (requestId == null || requestId.trim().isEmpty()) throw new IllegalArgumentException("requestId 不能为空");
        main.post(() -> beginInput(botId, requestId, listener));
    }

    void finishInput() {
        main.post(() -> {
            Capture current = capture;
            if (current != null && !closed.get()) current.input.finish();
        });
    }

    /** 仅当当前捕获仍属于预期 botId/requestId 时才结束输入：迟到的旧调用不得影响新捕获。 */
    void finishInput(String botId, String requestId) {
        main.post(() -> {
            Capture current = capture;
            if (current != null && !closed.get() && owns(current, botId, requestId)) current.input.finish();
        });
    }

    void cancelInput() {
        main.post(this::cancelCurrentSilently);
    }

    void cancelInput(String botId, String requestId) {
        main.post(() -> cancelIfOwned(botId, requestId));
    }

    private void cancelIfOwned(String botId, String requestId) {
        Capture current = capture;
        if (current == null || !owns(current, botId, requestId)) return;
        capture = null;
        current.input.cancel();
    }

    /** 冻结捕获身份校验：id 缺失时一律不操作，避免误清新捕获。 */
    private static boolean owns(Capture capture, String botId, String requestId) {
        return botId != null && requestId != null
                && botId.equals(capture.botId) && requestId.equals(capture.requestId);
    }

    JSONObject getSettings() {
        JSONObject out = new JSONObject();
        try {
            out.put("sttEngine", settings.sttEngine());
            out.put("ttsEngine", settings.ttsEngine());
            out.put("language", settings.language());
            out.put("speechRate", (double) settings.speechRate());
            out.put("stt", remoteObject(settings.remote(VoiceSettings.STT)));
            out.put("tts", remoteObject(settings.remote(VoiceSettings.TTS)));
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
        return out;
    }

    void saveSettings(JSONObject input) {
        if (input == null) throw new IllegalArgumentException("设置无效");
        String sttEngine = field(input, "sttEngine");
        String ttsEngine = field(input, "ttsEngine");
        if (sttEngine != null && !VoiceSettings.ENGINES.contains(sttEngine)) throw new IllegalArgumentException("sttEngine 无效");
        if (ttsEngine != null && !VoiceSettings.ENGINES.contains(ttsEngine)) throw new IllegalArgumentException("ttsEngine 无效");
        String language = field(input, "language");
        if (language != null && !language.isEmpty() && !language.matches("[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*"))
            throw new IllegalArgumentException("语言代码无效");
        double rate = Double.NaN;
        if (input.has("speechRate")) {
            try { rate = input.getDouble("speechRate"); } catch (JSONException invalid) { throw new IllegalArgumentException("speechRate 无效"); }
            if (!Double.isFinite(rate)) throw new IllegalArgumentException("speechRate 无效");
        }
        // 先整体校验（含合并后的有效远程配置）再应用，避免半套配置。
        JSONObject stt = remoteObject(input, "stt");
        JSONObject tts = remoteObject(input, "tts");
        RemoteEdit sttEdit = stt == null ? null : effectiveRemote(VoiceSettings.STT, stt);
        RemoteEdit ttsEdit = tts == null ? null : effectiveRemote(VoiceSettings.TTS, tts);
        if (sttEngine != null) settings.setEngine(VoiceSettings.STT, sttEngine);
        if (ttsEngine != null) settings.setEngine(VoiceSettings.TTS, ttsEngine);
        if (language != null) settings.setLanguage(language);
        if (!Double.isNaN(rate)) settings.setSpeechRate((float) rate);
        if (sttEdit != null) settings.setRemote(VoiceSettings.STT, sttEdit.baseUrl, sttEdit.model, sttEdit.voice, sttEdit.apiKey);
        if (ttsEdit != null) settings.setRemote(VoiceSettings.TTS, ttsEdit.baseUrl, ttsEdit.model, ttsEdit.voice, ttsEdit.apiKey);
    }

    void close() {
        if (!closed.compareAndSet(false, true)) return;
        speakGeneration.incrementAndGet();
        main.post(() -> { cancelCurrentSilently(); output.shutdown(); });
    }

    private void beginInput(String botId, String requestId, InputListener listener) {
        if (closed.get()) { listener.onError("语音已关闭"); return; }
        cancelCurrentSilently();
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            listener.onError("需要麦克风权限才能语音输入");
            return;
        }
        if (VoiceSettings.SYSTEM.equals(settings.sttEngine()) && !SpeechInput.systemAvailable(context, NS_VOICE)) {
            listener.onError("系统未提供语音识别，请在设置中改用远程模型");
            return;
        }
        SpeechInput input;
        try {
            input = VoiceSettings.REMOTE.equals(settings.sttEngine())
                    ? new SpeechInput.RemoteInput(settings.remote(VoiceSettings.STT), settings.language())
                    : new SpeechInput.SystemInput(context, settings.language(), NS_VOICE);
        } catch (RuntimeException failure) { listener.onError("无法启动语音输入"); return; }
        Capture started = new Capture(botId, requestId, listener, input);
        capture = started;
        try {
            input.start(new SpeechInput.Listener() {
                @Override public void onLevel(float level) { }
                @Override public void onPartial(String text) { if (!closed.get() && capture == started) listener.onPartial(text); }
                @Override public void onProcessing() { }
                @Override public void onResult(String text) {
                    if (!closed.get() && capture == started) { capture = null; listener.onResult(botId, requestId, text); }
                }
                @Override public void onError(String message) {
                    if (!closed.get() && capture == started) { capture = null; listener.onError(message); }
                }
            });
        } catch (RuntimeException failure) {
            capture = null;
            started.input.cancel();
            listener.onError("无法启动语音输入");
        }
    }

    private void cancelCurrentSilently() {
        Capture current = capture;
        if (current != null) { capture = null; current.input.cancel(); }
    }

    private static JSONObject remoteObject(VoiceSettings.Remote remote) {
        JSONObject out = new JSONObject();
        try {
            out.put("baseUrl", remote.baseUrl);
            out.put("model", remote.model);
            out.put("voice", remote.voice);
            out.put("configured", remote.configured()); // 端点+模型，不含密钥
            out.put("hasApiKey", !remote.apiKey.isEmpty());
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
        return out;
    }

    private static JSONObject remoteObject(JSONObject input, String key) {
        if (!input.has(key)) return null;
        JSONObject remote = input.optJSONObject(key);
        if (remote == null) throw new IllegalArgumentException(key + " 设置无效");
        return remote;
    }

    private static String field(JSONObject object, String key) {
        try { return object.has(key) ? object.getString(key) : null; }
        catch (JSONException invalid) { throw new IllegalArgumentException(key + " 无效"); }
    }

    /** 省略字段保留现有值；仅显式空串才清除。校验合并后的完整有效配置。 */
    private RemoteEdit effectiveRemote(String kind, JSONObject remote) {
        VoiceSettings.Remote current = settings.remote(kind);
        String baseUrl = field(remote, "baseUrl");
        String model = field(remote, "model");
        String voice = field(remote, "voice");
        String apiKey = remote.has("apiKey") ? field(remote, "apiKey") : null; // 省略保留，JSON null/非串拒绝
        if (baseUrl == null) baseUrl = current.baseUrl;
        if (model == null) model = current.model;
        if (voice == null) voice = current.voice;
        if (!baseUrl.trim().isEmpty()) {
            VoiceSettings.normalizeBaseUrl(baseUrl); // 无效地址抛 IllegalArgumentException
            if (model.trim().isEmpty()) throw new IllegalArgumentException("请填写模型名称");
        }
        return new RemoteEdit(baseUrl, model, voice, apiKey);
    }

    private static JSONObject accepted(boolean value) {
        try { return new JSONObject().put("accepted", value); }
        catch (JSONException impossible) { throw new IllegalStateException(impossible); }
    }

    private static <T> CompletableFuture<T> failed(Exception failure) {
        CompletableFuture<T> future = new CompletableFuture<>();
        future.completeExceptionally(failure);
        return future;
    }
}
