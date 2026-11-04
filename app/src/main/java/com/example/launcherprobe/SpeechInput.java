package com.example.launcherprobe;

import android.content.Context;
import android.content.Intent;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import java.util.ArrayList;
import java.util.Arrays;

/** One listening attempt. All listener callbacks arrive on the main thread, at most one terminal callback. */
abstract class SpeechInput {
    interface Listener {
        void onLevel(float level);
        default void onSpeechActivity(boolean speaking) { }
        void onPartial(String text);
        void onProcessing();
        void onResult(String text);
        void onError(String message);
    }

    protected final Handler main = new Handler(Looper.getMainLooper());
    protected Listener listener;
    private boolean finished;

    final void start(Listener listener) { this.listener = listener; begin(); }
    /** Stops capturing and delivers whatever was heard. */
    abstract void finish();
    /** Stops without delivering a result. */
    abstract void cancel();
    protected abstract void begin();

    protected final void deliver(Runnable callback) {
        main.post(() -> { if (!finished) callback.run(); });
    }
    protected final void result(String text) {
        main.post(() -> {
            if (finished) return;
            finished = true;
            if (text == null || text.trim().isEmpty()) listener.onError("未识别到语音");
            else listener.onResult(text.trim());
        });
    }
    protected final void error(String message) {
        main.post(() -> { if (!finished) { finished = true; listener.onError(message); } });
    }
    /** Called on the main thread; drops every callback still queued. */
    protected final void silence() { finished = true; }

    /**
     * The recognizer SystemInput should bind, or null for the system default.
     * Host 使用自己的偏好命名空间记录 previousRecognizer。
     */
    static android.content.ComponentName systemRecognizer(Context context, String prefsName) {
        String current = android.provider.Settings.Secure.getString(context.getContentResolver(), "voice_recognition_service");
        android.content.ComponentName component = current == null || current.isEmpty() ? null : android.content.ComponentName.unflattenFromString(current);
        if (component != null && !context.getPackageName().equals(component.getPackageName())) {
            context.getSharedPreferences(prefsName, Context.MODE_PRIVATE).edit().putString("previousRecognizer", current).apply();
            return null;
        }
        return fallbackRecognizer(context, prefsName);
    }

    /** Whether SystemInput can run at all. */
    static boolean systemAvailable(Context context, String prefsName) {
        return SpeechRecognizer.isRecognitionAvailable(context) && (systemRecognizer(context, prefsName) != null
                || !ownsDefaultRecognizer(context));
    }

    /** Another app's recognition service: the one in use before this app became default, else any installed one. */
    static android.content.ComponentName fallbackRecognizer(Context context, String prefsName) {
        java.util.List<android.content.pm.ResolveInfo> services = context.getPackageManager().queryIntentServices(
                new Intent(android.speech.RecognitionService.SERVICE_INTERFACE), 0);
        String previous = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE).getString("previousRecognizer", "");
        android.content.ComponentName first = null;
        for (android.content.pm.ResolveInfo info : services) {
            if (info.serviceInfo == null || context.getPackageName().equals(info.serviceInfo.packageName)) continue;
            android.content.ComponentName component = new android.content.ComponentName(info.serviceInfo.packageName, info.serviceInfo.name);
            if (component.flattenToString().equals(previous)) return component;
            if (first == null) first = component;
        }
        return first;
    }

    private static boolean ownsDefaultRecognizer(Context context) {
        String current = android.provider.Settings.Secure.getString(context.getContentResolver(), "voice_recognition_service");
        return current != null && current.startsWith(context.getPackageName() + "/");
    }

    static Intent recognizerIntent(String language) {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, "说出你的消息");
        if (language != null && !language.isEmpty()) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        return intent;
    }

    /** Android's recognition service, without its dialog. Must be created and driven on the main thread. */
    static final class SystemInput extends SpeechInput {
        private final Context context;
        private final String language;
        private final String prefsName;
        private SpeechRecognizer recognizer;
        private String partial = "";

        /** Host 使用独立命名空间，记录自己的 previousRecognizer。 */
        SystemInput(Context context, String language, String prefsName) {
            this.context = context; this.language = language; this.prefsName = prefsName;
        }

        @Override protected void begin() {
            android.content.ComponentName component = systemRecognizer(context, prefsName);
            recognizer = component == null ? SpeechRecognizer.createSpeechRecognizer(context)
                    : SpeechRecognizer.createSpeechRecognizer(context, component);
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) { }
                @Override public void onBeginningOfSpeech() { deliver(() -> listener.onSpeechActivity(true)); }
                @Override public void onRmsChanged(float db) { deliver(() -> listener.onLevel(Math.max(0, Math.min(1, (db + 2) / 12)))); }
                @Override public void onBufferReceived(byte[] buffer) { }
                @Override public void onEndOfSpeech() {
                    deliver(() -> { listener.onSpeechActivity(false); listener.onProcessing(); });
                }
                @Override public void onError(int code) {
                    if (!partial.isEmpty() && (code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT)) result(partial);
                    else error(message(code));
                    release();
                }
                @Override public void onResults(Bundle results) { result(first(results)); release(); }
                @Override public void onPartialResults(Bundle results) {
                    String text = first(results);
                    if (!text.isEmpty()) { partial = text; deliver(() -> listener.onPartial(text)); }
                }
                @Override public void onEvent(int type, Bundle params) { }
            });
            Intent intent = recognizerIntent(language)
                    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.getPackageName());
            recognizer.startListening(intent);
        }

        @Override void finish() { if (recognizer != null) recognizer.stopListening(); }
        @Override void cancel() { silence(); if (recognizer != null) recognizer.cancel(); release(); }

        private void release() {
            SpeechRecognizer current = recognizer;
            recognizer = null;
            if (current != null) main.post(current::destroy);
        }

        private static String first(Bundle results) {
            ArrayList<String> words = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            return words == null || words.isEmpty() || words.get(0) == null ? "" : words.get(0);
        }

        private static String message(int code) {
            switch (code) {
                case SpeechRecognizer.ERROR_NO_MATCH: case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "未识别到语音";
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "需要麦克风权限";
                case SpeechRecognizer.ERROR_NETWORK: case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "语音识别网络错误";
                case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "语音识别服务正忙，请稍后再试";
                case SpeechRecognizer.ERROR_AUDIO: return "麦克风录音失败";
                case 12: case 13: return "系统语音识别不支持当前语言";
                default: return "系统语音识别失败（" + code + "）";
            }
        }
    }

    /** Records locally, ends on silence, then uploads a WAV to an OpenAI-compatible transcription endpoint. */
    static final class RemoteInput extends SpeechInput {
        private final VoiceSettings.Remote remote;
        private final String language;
        private volatile boolean stopRequested, cancelled;
        private volatile okhttp3.Call call;
        private Thread worker;

        RemoteInput(VoiceSettings.Remote remote, String language) { this.remote = remote; this.language = language; }

        @Override protected void begin() {
            if (!remote.configured()) { error("远程语音识别尚未配置接口地址和模型"); return; }
            worker = new Thread(this::run, "voice-record");
            worker.start();
        }

        @Override void finish() { stopRequested = true; }
        @Override void cancel() {
            silence(); cancelled = true; stopRequested = true;
            okhttp3.Call current = call;
            if (current != null) current.cancel();
        }

        @android.annotation.SuppressLint("MissingPermission")
        private void run() {
            int frame = RemoteVoiceApi.SAMPLE_RATE * SpeechEndpointer.FRAME_MS / 1000;
            int minBuffer = AudioRecord.getMinBufferSize(RemoteVoiceApi.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            AudioRecord record;
            try {
                record = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RemoteVoiceApi.SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuffer, frame * 8));
            } catch (RuntimeException failure) { error("无法打开麦克风"); return; }
            if (record.getState() != AudioRecord.STATE_INITIALIZED) { record.release(); error("无法打开麦克风"); return; }
            SpeechEndpointer endpointer = new SpeechEndpointer();
            short[] samples = new short[RemoteVoiceApi.SAMPLE_RATE * 4];
            short[] buffer = new short[frame];
            int count = 0;
            try {
                record.startRecording();
                while (!stopRequested) {
                    int read = record.read(buffer, 0, frame);
                    if (read < 0) { error("麦克风录音失败"); return; }
                    if (count + read > samples.length) samples = Arrays.copyOf(samples, samples.length * 2);
                    System.arraycopy(buffer, 0, samples, count, read);
                    count += read;
                    SpeechEndpointer.State state = endpointer.feed(buffer, read);
                    float level = endpointer.level();
                    deliver(() -> listener.onLevel(level));
                    if (state == SpeechEndpointer.State.NO_SPEECH) { error("未检测到语音"); return; }
                    if (state == SpeechEndpointer.State.DONE || state == SpeechEndpointer.State.TOO_LONG) break;
                }
            } finally {
                try { record.stop(); } catch (IllegalStateException ignored) { }
                record.release();
            }
            if (cancelled) return;
            if (!endpointer.heardSpeech() && count < RemoteVoiceApi.SAMPLE_RATE / 2) { error("未检测到语音"); return; }
            deliver(() -> listener.onProcessing());
            try {
                call = RemoteVoiceApi.transcribeCall(remote, RemoteVoiceApi.wav(samples, count), language);
                if (cancelled) return;
                result(RemoteVoiceApi.transcription(call));
            } catch (Exception failure) {
                if (!cancelled) error(failure.getMessage() == null ? "远程语音识别失败" : failure.getMessage());
            }
        }
    }
}
