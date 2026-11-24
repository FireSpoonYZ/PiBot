import assert from 'node:assert/strict';
import test from 'node:test';
import { createPetVoice, encodeVoiceWav } from '../../desktop/web/src/pet/voice.ts';
import { completePetAction } from '../../desktop/web/src/pet/drafts.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));
const settings = {
  stt: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper', voice: '', hasApiKey: false },
  tts: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'tts', voice: 'alloy', hasApiKey: false },
  ttsEngine: 'remote', language: 'zh-CN', speechRate: 1,
};

function installEnvironment(t, request) {
  const contexts = [];
  const streams = [];
  const audios = [];
  class FakeContext {
    sampleRate = 48000;
    destination = {};
    closed = 0;
    constructor() { contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.closed++; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      this.processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      return this.processor;
    }
  }
  class FakeAudio {
    paused = 0;
    srcRemoved = false;
    constructor(url) { this.url = url; audios.push(this); }
    play() { return Promise.resolve(); }
    pause() { this.paused++; }
    removeAttribute(name) { if (name === 'src') this.srcRemoved = true; }
  }
  const stream = () => {
    const track = { stopped: 0, stop() { this.stopped++; } };
    const value = { track, getTracks: () => [track] };
    streams.push(value);
    return value;
  };
  const old = new Map();
  const install = (name, value) => {
    old.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install('window', {
    AudioContext: FakeContext,
    __TAURI_INTERNALS__: {
      invoke: (_command, { request: input }) => input.action === 'settings-get'
        ? Promise.resolve(settings) : request(input),
    },
  });
  install('AudioContext', FakeContext);
  install('Audio', FakeAudio);
  install('navigator', { language: 'zh-CN', mediaDevices: { getUserMedia: async () => stream() } });
  t.after(() => {
    for (const [name, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { contexts, streams, audios, stream };
}

test('speech WAV is mono PCM16 at 16 kHz with bounded samples', () => {
  const wav = encodeVoiceWav([new Float32Array(480).fill(2), new Float32Array(480).fill(-2)], 48000);
  const view = new DataView(wav.buffer);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 640);
  assert.equal(wav.length, 684);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(44 + 320, true), -32768);
});

test('cancel while microphone permission is pending closes the eventual stream', async (t) => {
  const env = installEnvironment(t, async () => ({}));
  let grant;
  navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const states = [];
  const voice = createPetVoice({ onState: state => states.push(state.phase) });
  t.after(() => voice.dispose());
  const starting = voice.startRecording();
  await settle();
  voice.cancelRecording();
  const stream = env.stream();
  grant(stream);
  await starting;
  assert.equal(stream.track.stopped, 1);
  assert.equal(env.contexts[0].closed, 1);
  assert.equal(states.at(-1), 'idle');
  assert.equal(await voice.finishRecording(), '');
});

test('finishing releases microphone before transcription, then cancel drops a late transcript', async (t) => {
  const requests = [];
  let transcribed;
  const env = installEnvironment(t, input => {
    requests.push(input);
    if (input.action === 'transcribe') return new Promise(resolve => { transcribed = resolve; });
    return Promise.resolve({});
  });
  const voice = createPetVoice();
  t.after(() => voice.dispose());
  await voice.startRecording();
  env.contexts[0].processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(.2) } });
  const finished = voice.finishRecording();
  assert.equal(env.streams[0].track.stopped, 1);
  assert.equal(env.contexts[0].closed, 1);
  voice.cancelRecording();
  assert.equal(requests[1].action, 'cancel');
  assert.equal(requests[1].requestId, requests[0].requestId);
  transcribed({ text: 'Late voice intent' });
  assert.equal(await finished, '');
});

test('stop reading cancels pending TTS and never plays its late audio', async (t) => {
  let synthesized;
  const requests = [];
  const env = installEnvironment(t, input => {
    requests.push(input);
    if (input.action === 'speak') return new Promise(resolve => { synthesized = resolve; });
    return Promise.resolve({});
  });
  const voice = createPetVoice();
  t.after(() => voice.dispose());
  const speaking = voice.speak('A reply');
  await settle();
  voice.stopSpeaking();
  synthesized({ audioBase64: btoa('audio'), mimeType: 'audio/mpeg' });
  await speaking;
  assert.equal(env.audios.length, 0);
  assert.equal(requests[1].action, 'cancel');
  assert.equal(requests[0].requestId, requests[1].requestId);
});

test('stop reading pauses current playback and resolves the speech queue', async (t) => {
  const env = installEnvironment(t, async input => input.action === 'speak'
    ? { audioBase64: btoa('audio'), mimeType: 'audio/mpeg' } : {});
  const voice = createPetVoice();
  t.after(() => voice.dispose());
  const speaking = voice.speak('A reply');
  await settle();
  assert.equal(env.audios.length, 1);
  voice.stopSpeaking();
  await speaking;
  assert.equal(env.audios[0].paused, 1);
  assert.equal(env.audios[0].srcRemoved, true);
});

test('main clears confirmed pet drafts even when the pet window has closed, preserving newer edits', () => {
  const key = 'pibot-desktop-pet-draft:v1:device:bot';
  const values = new Map([[key, 'Queued text']]);
  const storage = { getItem: name => values.get(name) ?? null, removeItem: name => values.delete(name) };
  const action = { id: 'send', kind: 'send', deviceId: 'device', botId: 'bot', text: 'Queued text' };
  const result = completePetAction(action, { id: 'send', ok: false, pendingId: 'durable-record' }, storage);
  assert.equal(values.has(key), false);
  assert.deepEqual(result.queuedDraft, { deviceId: 'device', botId: 'bot', text: 'Queued text' });
  values.set(key, 'New draft written while sending');
  completePetAction(action, { id: 'send', ok: true, pendingId: 'durable-record' }, storage);
  assert.equal(values.get(key), 'New draft written while sending');
});
