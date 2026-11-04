package com.example.launcherprobe;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Reads text aloud with the system TTS engine or an OpenAI-compatible speech endpoint. A new speak() replaces the old one. */
final class SpeechOutput {
    private static final int SYSTEM_CHUNK = 3_000, REMOTE_CHUNK = 400;
    private static final AudioAttributes ATTRIBUTES = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();

    private final Context context;
    private final VoiceSettings settings;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService remote = Executors.newCachedThreadPool();
    private final AtomicInteger generation = new AtomicInteger();
    private final AudioManager audio;
    private AudioFocusRequest focus;
    private TextToSpeech tts;
    private boolean ttsReady, ttsFailed;
    private final List<Runnable> waitingForTts = new ArrayList<>();
    private volatile MediaPlayer player;
    private volatile PcmSpeech pcm;
    private volatile okhttp3.Call remoteCall;
    private volatile boolean speaking;
    private int ttsAudioSession;

    SpeechOutput(Context context, VoiceSettings settings) {
        this.context = context.getApplicationContext();
        this.settings = settings;
        audio = this.context.getSystemService(AudioManager.class);
    }

    private static final String STREAM_END = "\u0000end";

    void speak(String markdown) {
        String text = SpeechText.plain(markdown);
        stop();
        if (text.isEmpty()) return;
        int token = generation.get();
        speaking = true;
        requestFocus();
        if (VoiceSettings.REMOTE.equals(settings.ttsEngine())) {
            VoiceSettings.Remote config = settings.remote(VoiceSettings.TTS);
            if ("kokoro".equalsIgnoreCase(config.model)) {
                java.util.concurrent.BlockingQueue<String> queue = new java.util.concurrent.LinkedBlockingQueue<>();
                queue.addAll(SpeechText.chunks(text, REMOTE_CHUNK));
                queue.add(STREAM_END);
                remote.execute(() -> streamPcm(token, config, queue));
            } else remote.execute(() -> speakRemote(token, config, SpeechText.chunks(text, REMOTE_CHUNK), text));
        } else speakSystem(token, text);
    }

    synchronized void stop() {
        generation.incrementAndGet();
        okhttp3.Call call = remoteCall;
        if (call != null) call.cancel();
        PcmSpeech currentPcm = pcm;
        if (currentPcm != null) currentPcm.stop();
        MediaPlayer current = player;
        if (current != null) main.post(() -> { try { current.stop(); } catch (IllegalStateException ignored) { } });
        if (Looper.myLooper() == Looper.getMainLooper()) {
            if (tts != null && ttsReady) tts.stop();
        } else main.post(() -> { if (tts != null && ttsReady) tts.stop(); });
        done(-1);
    }

    void shutdown() {
        stop();
        main.post(() -> { if (tts != null) tts.shutdown(); tts = null; });
        remote.shutdownNow();
    }

    private void speakSystem(int token, String text) {
        main.post(() -> withTts(() -> {
            if (token != generation.get()) return;
            if (ttsFailed) { failed(token, "系统语音合成不可用，请在系统设置中安装或启用 TTS 引擎"); return; }
            tts.setSpeechRate(settings.speechRate());
            String language = settings.language();
            if (!language.isEmpty()) tts.setLanguage(Locale.forLanguageTag(language));
            List<String> chunks = SpeechText.chunks(text, Math.min(SYSTEM_CHUNK, TextToSpeech.getMaxSpeechInputLength() - 1));
            for (int i = 0; i < chunks.size(); i++) {
                android.os.Bundle params = new android.os.Bundle();
                params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
                params.putInt(TextToSpeech.Engine.KEY_PARAM_SESSION_ID, ttsAudioSession);
                String id = token + ":" + (i == chunks.size() - 1 ? "last" : String.valueOf(i));
                tts.speak(chunks.get(i), i == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, params, id);
            }
        }));
    }

    private void withTts(Runnable action) {
        if (tts != null && (ttsReady || ttsFailed)) { action.run(); return; }
        waitingForTts.add(action);
        if (tts != null) return;
        tts = new TextToSpeech(context, status -> main.post(() -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            ttsFailed = !ttsReady;
            if (ttsReady) {
                tts.setAudioAttributes(ATTRIBUTES);
                ttsAudioSession = audio == null ? 0 : audio.generateAudioSessionId();
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { }
                    @Override public void onDone(String id) { finished(id); }
                    @Override public void onError(String id) { finished(id); }
                    private void finished(String id) {
                        main.post(() -> {
                            if (tokenOf(id) != generation.get()) return;
                            if (id.endsWith(":last")) done(tokenOf(id));
                        });
                    }
                });
            }
            List<Runnable> pending = new ArrayList<>(waitingForTts);
            waitingForTts.clear();
            for (Runnable run : pending) run.run();
            if (ttsFailed) tts = null;
        }));
    }

    /** A single track spans the reply; subsequent requests start while buffered samples still play. */
    private void streamPcm(int token, VoiceSettings.Remote config,
            java.util.concurrent.BlockingQueue<String> queue) {
        PcmSpeech owned = null;
        String problem = null;
        try {
            owned = new PcmSpeech(ATTRIBUTES);
            synchronized (this) {
                if (token != generation.get()) return;
                pcm = owned;
            }
            boolean received = false;
            while (token == generation.get()) {
                String text = queue.poll(200, TimeUnit.MILLISECONDS);
                if (text == null) continue;
                if (STREAM_END.equals(text)) break;
                okhttp3.Call call = RemoteVoiceApi.speechCall(config, text, settings.speechRate());
                remoteCall = call;
                if (token != generation.get()) { call.cancel(); break; }
                try (okhttp3.Response response = RemoteVoiceApi.speechResponse(call)) {
                    okhttp3.MediaType type = response.body().contentType();
                    if (type == null || !"audio".equals(type.type()) || !"pcm".equals(type.subtype()))
                        throw new java.io.IOException("Kokoro 必须返回 24 kHz 单声道 PCM 音频");
                    received = true;
                    owned.append(response.body().byteStream(), () -> token == generation.get());
                } finally {
                    if (remoteCall == call) remoteCall = null;
                }
            }
            if (received) owned.drain(() -> token == generation.get());
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        } catch (Exception failure) {
            problem = failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage();
        } finally {
            synchronized (this) {
                if (pcm == owned) pcm = null;
            }
            if (owned != null) owned.close();
            String message = problem;
            main.post(() -> {
                if (token != generation.get()) return;
                if (message != null) Toast.makeText(context, UiText.get(context, "远程语音朗读失败，请检查语音设置"), Toast.LENGTH_SHORT).show();
                // Do not switch speakers or replay the reply when a partially played stream fails.
                done(token);
            });
        }
    }

    /** Synthesizes the next chunk while the current one plays. */
    private void speakRemote(int token, VoiceSettings.Remote config, List<String> chunks, String fullText) {
        File dir = new File(context.getCacheDir(), "voice");
        dir.mkdirs();
        Future<File> next = null;
        try {
            for (int i = 0; i < chunks.size() && token == generation.get(); i++) {
                Future<File> current = next != null ? next : synthesize(token, config, chunks.get(i), new File(dir, "tts-" + token + "-" + i + ".mp3"));
                next = i + 1 < chunks.size() ? synthesize(token, config, chunks.get(i + 1), new File(dir, "tts-" + token + "-" + (i + 1) + ".mp3")) : null;
                File file = current.get(150, TimeUnit.SECONDS);
                if (token != generation.get()) return;
                play(token, file);
                file.delete();
            }
            done(token);
        } catch (Exception failure) {
            if (token != generation.get()) return;
            Throwable cause = failure instanceof java.util.concurrent.ExecutionException && failure.getCause() != null ? failure.getCause() : failure;
            String message = cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage();
            main.post(() -> {
                if (token != generation.get()) return;
                Toast.makeText(context, UiText.get(context, "远程语音暂不可用，已切换为系统朗读"), Toast.LENGTH_SHORT).show();
                speakSystem(token, fullText);
            });
        } finally {
            if (next != null) next.cancel(true);
        }
    }

    private Future<File> synthesize(int token, VoiceSettings.Remote config, String text, File target) {
        return remote.submit(() -> {
            okhttp3.Call call = RemoteVoiceApi.speechCall(config, text, settings.speechRate());
            remoteCall = call;
            if (token != generation.get()) call.cancel();
            byte[] bytes = RemoteVoiceApi.audio(call);
            try (FileOutputStream output = new FileOutputStream(target)) { output.write(bytes); }
            return target;
        });
    }

    private void play(int token, File file) throws Exception {
        CountDownLatch finished = new CountDownLatch(1);
        String[] error = new String[1];
        MediaPlayer[] owned = new MediaPlayer[1];
        main.post(() -> {
            if (token != generation.get()) { finished.countDown(); return; }
            MediaPlayer media = new MediaPlayer();
            owned[0] = media;
            try {
                media.setAudioAttributes(ATTRIBUTES);
                media.setDataSource(file.getAbsolutePath());
                media.setOnCompletionListener(done -> {
                    finished.countDown();
                });
                media.setOnErrorListener((failed, what, extra) -> {
                    error[0] = "音频无法播放（" + what + "）"; finished.countDown(); return true;
                });
                media.prepare();
                player = media;
                media.start();
            } catch (Exception failure) { error[0] = "音频无法播放"; finished.countDown(); }
        });
        while (!finished.await(200, TimeUnit.MILLISECONDS)) if (token != generation.get()) break;
        main.post(() -> {
            MediaPlayer media = owned[0];
            if (player == media) player = null;
            if (media != null) media.release();
        });
        if (error[0] != null && token == generation.get()) throw new java.io.IOException(error[0]);
    }

    private void failed(int token, String message) {
        Toast.makeText(context, UiText.get(context, message), Toast.LENGTH_LONG).show();
        done(token);
    }

    /** token -1 always ends; otherwise only the current generation ends. */
    private void done(int token) {
        if (token != -1 && token != generation.get()) return;
        speaking = false;
        main.post(this::abandonFocus);
    }

    private void requestFocus() {
        if (audio == null) return;
        if (focus == null) focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(ATTRIBUTES).build();
        audio.requestAudioFocus(focus);
    }

    private void abandonFocus() {
        if (audio != null && focus != null && !speaking) { audio.abandonAudioFocusRequest(focus); focus = null; }
    }

    private static int tokenOf(String id) {
        try { return Integer.parseInt(id.substring(0, id.indexOf(':'))); } catch (RuntimeException invalid) { return -2; }
    }
}
