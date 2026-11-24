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

function isEnglishUi(): boolean {
  return typeof window !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.language === 'string'
    && navigator.language.startsWith('en');
}

function uiText(zh: string, en: string): string {
  return isEnglishUi() ? en : zh;
}

const KNOWN_NATIVE_VOICE_MESSAGES_EN: Record<string, string> = {
  '无法访问语音设置目录': 'Could not access the voice settings folder.',
  '语音设置无法读取，请重新保存': 'Voice settings could not be read. Save them again.',
  '无法读取语音设置': 'Could not read voice settings.',
  '语音接口地址无效': 'Invalid speech API base URL.',
  '接口需为 HTTPS 地址，本机服务可使用 HTTP；地址中不能包含密钥或参数':
    'Use an HTTPS URL (HTTP is allowed for local services only) without credentials or query parameters.',
  '请填写语音模型名称': 'Enter a speech model name.',
  '朗读引擎无效': 'Invalid speech engine.',
  '朗读速度应在 0.5 到 2 倍之间': 'Speech rate must be between 0.5× and 2×.',
  '请先在语音设置中填写接口地址与模型': 'Configure the speech API base URL and model in Voice settings first.',
  '语音服务请求超时': 'Speech service request timed out.',
  '无法连接语音服务，请检查地址和网络': 'Could not reach the speech service. Check the URL and network.',
  '语音服务未返回有效转写结果': 'Speech service did not return a valid transcript.',
  '语音服务未返回转写文本': 'Speech service did not return transcript text.',
  '朗读文本为空或过长': 'Speech text is empty or too long.',
  '无法读取语音音频': 'Could not read speech audio.',
  '语音服务返回了空音频': 'Speech service returned empty audio.',
  '语音已停止': 'Speech stopped.',
  '语音处理失败': 'Speech request failed.',
};

export function voiceError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError') {
      return uiText('请允许 PiBot 使用麦克风', 'Allow PiBot to access the microphone.');
    }
    if (error.name === 'NotFoundError') {
      return uiText('未找到可用麦克风', 'No microphone was found.');
    }
    return isEnglishUi()
      ? (KNOWN_NATIVE_VOICE_MESSAGES_EN[error.message] ?? error.message)
      : error.message;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = String(error.message);
    if (isEnglishUi()) {
      const httpMatch = /^语音服务返回 HTTP (\d+)/.exec(msg);
      if (httpMatch) return `Speech service returned HTTP ${httpMatch[1]}. Check the model and credentials.`;
      return KNOWN_NATIVE_VOICE_MESSAGES_EN[msg] ?? msg;
    }
    return msg;
  }
  return String(error);
}

/** Convert Markdown prose to clean spoken text so TTS never reads syntax symbols or URLs aloud. */
export function stripMarkdownForSpeech(input: string): string {
  const cleanInline = (raw: string): string =>
    raw
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
      .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?=[^\w*]|$)/g, '$1$2')
      .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?=[^\w]|$)/g, '$1$2')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '')
      .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, '')
      .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
        row.split('|').map((cell) => cell.trim()).filter(Boolean).join('，'))
      .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .trim();

  const withoutFences = input.replace(/```[^\n]*\n[\s\S]*?```/g, '\n');
  const stripped = cleanInline(withoutFences);
  if (stripped) return stripped;
  // If the entire message was fenced code or URLs, fall back to readable plain text without fence markers.
  return input
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
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
        throw new Error(uiText(
          '此桌面环境未提供麦克风录音，请检查系统音频支持',
          'Microphone capture is unavailable in this desktop environment. Check system audio support.',
        ));
      }
      const context = new AudioContext();
      let stream: MediaStream | null = null;
      try {
        // Resume inside the button's user gesture, before awaiting settings or permissions.
        const [, settings] = await Promise.all([context.resume(), getPetVoiceSettings()]);
        if (!settings.stt.baseUrl || !settings.stt.model) {
          throw new Error(uiText(
            '请先设置语音识别接口与模型',
            'Configure the transcription API base URL and model in Voice settings first.',
          ));
        }
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
          state('error', uiText(
            '录音已停止：单次最长两分钟，请分段说话',
            'Recording stopped: maximum 2 minutes per clip.',
          ));
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
        audio.onerror = () => finish(new Error(uiText(
          '无法播放语音，请检查系统音频支持',
          'Could not play audio. Check system audio output.',
        )));
        void audio.play().catch(() => finish(new Error(uiText(
          '语音播放未获允许，请点击朗读按钮重试',
          'Audio playback was blocked. Click Read aloud to try again.',
        ))));
      });
    } finally {
      if (speechId === requestId) speechId = null;
    }
  }

  async function playSystem(text: string, settings: PetVoiceSettings, epoch: number): Promise<void> {
    const voices = await systemVoices();
    if (disposed || speechEpoch !== epoch) return;
    if (!voices.length) {
      throw new Error(uiText(
        '系统未提供可用声音，请安装系统语音或在设置中选择远程朗读',
        'No system voices are installed. Install a system voice or choose Remote speech API in Voice settings.',
      ));
    }
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
      utterance.onerror = (event) => finish(new Error(uiText(
        '系统朗读失败：' + event.error,
        'System speech failed: ' + event.error,
      )));
      window.speechSynthesis.speak(utterance);
    });
  }

  function speak(text: string): Promise<void> {
    const spoken = stripMarkdownForSpeech(text);
    if (disposed || !spoken) return Promise.resolve();
    const epoch = speechEpoch;
    const task = speechQueue.catch(() => {}).then(async () => {
      if (disposed || epoch !== speechEpoch) return;
      const settings = await getPetVoiceSettings();
      if (disposed || epoch !== speechEpoch) return;
      state('speaking');
      try {
        if (settings.ttsEngine === 'remote') await playRemote(spoken, epoch);
        else await playSystem(spoken, settings, epoch);
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
