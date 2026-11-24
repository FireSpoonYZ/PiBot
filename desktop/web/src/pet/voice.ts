import { invoke } from '@tauri-apps/api/core';

export interface VoiceEndpoint {
  baseUrl: string;
  model: string;
  voice: string;
  hasApiKey: boolean;
}
export interface PetVoiceSettings {
  stt: VoiceEndpoint;
  tts: VoiceEndpoint;
  ttsEngine: 'system' | 'remote';
  language: string;
  speechRate: number;
}
export type VoiceEndpointInput = Omit<VoiceEndpoint, 'hasApiKey'> & {
  apiKey?: string;
  clearApiKey?: boolean;
};
export type PetVoiceSettingsInput = Omit<PetVoiceSettings, 'stt' | 'tts'> & {
  stt: VoiceEndpointInput;
  tts: VoiceEndpointInput;
};
export interface PetVoiceStatus {
  phase: 'idle' | 'recording' | 'transcribing' | 'speaking' | 'error';
  error?: string;
}
export interface PetVoice {
  startRecording(): Promise<void>;
  finishRecording(): Promise<string>;
  cancelRecording(): void;
  speak(text: string): Promise<void>;
  stopSpeaking(): void;
  dispose(): void;
}

const command = <T>(request: Record<string, unknown>) =>
  invoke<T>('desktop_pet_voice', { request });

export const getPetVoiceSettings = () => command<PetVoiceSettings>({ action: 'settings-get' });
export const savePetVoiceSettings = (settings: PetVoiceSettingsInput) =>
  command<PetVoiceSettings>({ action: 'settings-save', settings });

export function voiceError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError') return '请允许 PiBot 使用麦克风';
    if (error.name === 'NotFoundError') return '未找到可用麦克风';
    return error.message;
  }
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** One mono PCM16 WAV at 16 kHz, accepted by OpenAI-compatible transcription endpoints. */
export function encodeVoiceWav(chunks: readonly Float32Array[], sourceRate: number): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const samples = new Float32Array(size);
  let offset = 0;
  for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
  const ratio = sourceRate / 16000;
  const count = Math.floor(size / ratio);
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(size, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let value = 0;
    for (let j = start; j < end; j++) value += samples[j];
    value = Math.max(-1, Math.min(1, value / (end - start)));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

/** Split only completed sentences while streaming; flush the remainder on turn completion. */
export function splitSpeechText(text: string, flush = false): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  const boundary = /[。！？!?\n]+|\.(?=\s|$)/g;
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const end = (match.index ?? 0) + match[0].length;
    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }
  const remainder = text.slice(start);
  if (flush && remainder.trim()) sentences.push(remainder.trim());
  return { sentences, remainder: flush ? '' : remainder };
}

interface Recording {
  epoch: number;
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  mute: GainNode;
  chunks: Float32Array[];
  timer: ReturnType<typeof setTimeout>;
}

async function systemVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis;
  if (!synth) return [];
  const existing = synth.getVoices();
  if (existing.length) return existing;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      synth.removeEventListener('voiceschanged', done);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(done, 1200);
    synth.addEventListener('voiceschanged', done);
  });
}

export function createPetVoice(options: { onState?: (status: PetVoiceStatus) => void } = {}): PetVoice {
  let disposed = false;
  let captureEpoch = 0;
  let speechEpoch = 0;
  let recording: Recording | null = null;
  let starting: Promise<void> | null = null;
  let transcriptionId: string | null = null;
  let speechId: string | null = null;
  let playbackStop: (() => void) | null = null;
  let speechQueue: Promise<void> = Promise.resolve();
  const state = (phase: PetVoiceStatus['phase'], error?: string) => {
    if (!disposed) options.onState?.({ phase, ...(error ? { error } : {}) });
  };
  const cancelRequest = (id: string | null) => {
    if (id) void command({ action: 'cancel', requestId: id }).catch(() => {});
  };
  const release = (capture: Recording) => {
    clearTimeout(capture.timer);
    capture.processor.onaudioprocess = null;
    capture.source.disconnect();
    capture.processor.disconnect();
    capture.mute.disconnect();
    capture.stream.getTracks().forEach((track) => track.stop());
    void capture.context.close().catch(() => {});
  };
  const cancelRecording = () => {
    captureEpoch++;
    if (recording) release(recording);
    recording = null;
    cancelRequest(transcriptionId);
    transcriptionId = null;
    state('idle');
  };
  const stopSpeaking = () => {
    speechEpoch++;
    cancelRequest(speechId);
    speechId = null;
    playbackStop?.();
    playbackStop = null;
    speechQueue = Promise.resolve();
    if (!recording && !starting && !transcriptionId) state('idle');
  };

  async function startRecording(): Promise<void> {
    if (disposed) return;
    stopSpeaking();
    cancelRecording();
    const epoch = captureEpoch;
    state('recording');
    const pending = (async () => {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
        throw new Error('此桌面环境未提供麦克风录音，请检查系统音频支持');
      }
      const context = new AudioContext();
      let stream: MediaStream | null = null;
      try {
        // Resume inside the button's user gesture, before awaiting settings or permissions.
        const [, settings] = await Promise.all([context.resume(), getPetVoiceSettings()]);
        if (!settings.stt.baseUrl || !settings.stt.model) throw new Error('请先设置语音识别接口与模型');
        if (epoch !== captureEpoch || disposed) return;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        if (epoch !== captureEpoch || disposed) return;
        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(2048, 1, 1);
        const mute = context.createGain();
        mute.gain.value = 0;
        const chunks: Float32Array[] = [];
        processor.onaudioprocess = (event) => chunks.push(event.inputBuffer.getChannelData(0).slice());
        source.connect(processor); processor.connect(mute); mute.connect(context.destination);
        const timer = setTimeout(() => {
          if (recording?.epoch !== epoch) return;
          cancelRecording();
          state('error', '录音已停止：单次最长两分钟，请分段说话');
        }, 120000);
        recording = { epoch, context, stream, source, processor, mute, chunks, timer };
      } finally {
        if (recording?.context !== context) {
          stream?.getTracks().forEach((track) => track.stop());
          void context.close().catch(() => {});
        }
      }
    })();
    starting = pending;
    try { await pending; }
    catch (error) {
      if (epoch !== captureEpoch || disposed) return;
      state('error', voiceError(error));
      throw error;
    } finally {
      if (starting === pending) starting = null;
    }
  }

  async function finishRecording(): Promise<string> {
    const epoch = captureEpoch;
    if (starting) await starting;
    const capture = recording;
    if (!capture || capture.epoch !== epoch || disposed) return '';
    recording = null;
    release(capture);
    if (!capture.chunks.length) { state('idle'); return ''; }
    const wav = encodeVoiceWav(capture.chunks, capture.context.sampleRate);
    const requestId = crypto.randomUUID();
    transcriptionId = requestId;
    state('transcribing');
    try {
      const result = await command<{ text: string }>({
        action: 'transcribe', requestId, audioBase64: toBase64(wav),
      });
      if (epoch !== captureEpoch || disposed) return '';
      state('idle');
      return result.text.trim();
    } catch (error) {
      if (epoch !== captureEpoch || disposed) return '';
      state('error', voiceError(error));
      throw error;
    } finally {
      if (transcriptionId === requestId) transcriptionId = null;
    }
  }

  async function playRemote(text: string, epoch: number): Promise<void> {
    const requestId = crypto.randomUUID();
    speechId = requestId;
    try {
      const result = await command<{ audioBase64: string; mimeType: string }>({ action: 'speak', requestId, text });
      if (disposed || speechEpoch !== epoch) return;
      const bytes = Uint8Array.from(atob(result.audioBase64), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      await new Promise<void>((resolve, reject) => {
        const audio = new Audio(url);
        const finish = (error?: Error) => {
          audio.onended = null;
          audio.onerror = null;
          audio.pause();
          audio.removeAttribute('src');
          URL.revokeObjectURL(url);
          if (playbackStop === stop) playbackStop = null;
          error ? reject(error) : resolve();
        };
        const stop = () => finish();
        playbackStop = stop;
        audio.onended = () => finish();
        audio.onerror = () => finish(new Error('无法播放语音，请检查系统音频支持'));
        void audio.play().catch(() => finish(new Error('语音播放未获允许，请点击朗读按钮重试')));
      });
    } finally {
      if (speechId === requestId) speechId = null;
    }
  }

  async function playSystem(text: string, settings: PetVoiceSettings, epoch: number): Promise<void> {
    const voices = await systemVoices();
    if (disposed || speechEpoch !== epoch) return;
    if (!voices.length) throw new Error('系统未提供可用声音，请安装系统语音或在设置中选择远程朗读');
    await new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = settings.language || navigator.language;
      utterance.rate = settings.speechRate;
      utterance.voice = voices.find((voice) => voice.lang.toLowerCase() === utterance.lang.toLowerCase())
        ?? voices.find((voice) => voice.lang.split('-')[0] === utterance.lang.split('-')[0])
        ?? voices.find((voice) => voice.default) ?? voices[0];
      const finish = (error?: Error) => {
        utterance.onend = null;
        utterance.onerror = null;
        if (playbackStop === stop) playbackStop = null;
        error ? reject(error) : resolve();
      };
      const stop = () => { finish(); window.speechSynthesis.cancel(); };
      playbackStop = stop;
      utterance.onend = () => finish();
      utterance.onerror = (event) => finish(new Error('系统朗读失败：' + event.error));
      window.speechSynthesis.speak(utterance);
    });
  }

  function speak(text: string): Promise<void> {
    if (disposed || !text.trim()) return Promise.resolve();
    const epoch = speechEpoch;
    const task = speechQueue.catch(() => {}).then(async () => {
      if (disposed || epoch !== speechEpoch) return;
      const settings = await getPetVoiceSettings();
      if (disposed || epoch !== speechEpoch) return;
      state('speaking');
      try {
        if (settings.ttsEngine === 'remote') await playRemote(text, epoch);
        else await playSystem(text, settings, epoch);
        if (!disposed && epoch === speechEpoch) state('idle');
      } catch (error) {
        if (disposed || epoch !== speechEpoch) return;
        state('error', voiceError(error));
        throw error;
      }
    });
    speechQueue = task;
    return task;
  }

  return {
    startRecording, finishRecording, cancelRecording, speak, stopSpeaking,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelRecording();
      stopSpeaking();
    },
  };
}
