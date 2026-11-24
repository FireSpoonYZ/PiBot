import { useCallback, useEffect, useRef, useState } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { ArrowUp, ChevronDown, ExternalLink, Mic, RefreshCw, Settings2, Square, Volume2, VolumeX, X } from 'lucide-react';
import { getDefaultBotAvatarPreset, GrokBotAnimatedMark } from '../../../../web/src/GrokBotAvatar';
import { botActivityText, isBotActivityBusy } from '../../../../web/src/botActivity';
import { useText } from '../../../../web/src/ui';
import {
  INITIAL_PET_SNAPSHOT, PET_EVENTS,
  type DesktopPetAction, type DesktopPetResult, type DesktopPetSnapshot, type DesktopPetWindowState,
} from './protocol';
import { createPetVoice, voiceError, type PetVoiceStatus } from './voice';
import { VoiceSettings } from './VoiceSettings';
import { petWindow } from './windowApi';

const AUTO_READ_KEY = 'pibot-desktop-pet-auto-read:v1';
const targetKey = (state: DesktopPetSnapshot) =>
  state.deviceId && state.botId ? state.deviceId + ':' + state.botId : '';
const draftKey = (key: string) => 'pibot-desktop-pet-draft:v1:' + key;
function readLocal(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}
function writeLocal(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch { /* The current editor remains usable when local storage is unavailable. */ }
}
const postAction = (action: DesktopPetAction) => emitTo('main', PET_EVENTS.action, action);
type SendFlight = { id: string; key: string; text: string; assistantIds: Set<string> };
type Recording = { key: string; start: Promise<void>; released: boolean };

export function PetApp() {
  const t = useText();
  const [snapshot, setSnapshot] = useState(INITIAL_PET_SNAPSHOT);
  const snapshotRef = useRef(snapshot);
  const [expanded, setExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const [notice, setNotice] = useState('');
  const [sendFlight, setSendFlight] = useState<SendFlight | null>(null);
  const sendFlightRef = useRef<SendFlight | null>(null);
  const [autoRead, setAutoRead] = useState(() => readLocal(AUTO_READ_KEY) === 'true');
  const [replyToRead, setReplyToRead] = useState<SendFlight | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<PetVoiceStatus>({ phase: 'idle' });
  const [voice] = useState(() => createPetVoice({ onState: setVoiceStatus }));
  const recordingRef = useRef<Recording | null>(null);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const pointerRef = useRef<{ id: number; x: number; y: number; dragged: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  const report = useCallback((error: unknown) => setNotice(voiceError(error)), []);
  const changeDraft = useCallback((text: string, key = targetKey(snapshotRef.current)) => {
    if (key) writeLocal(draftKey(key), text);
    if (key === targetKey(snapshotRef.current)) {
      setNotice('');
      draftRef.current = text;
      setDraft(text);
    }
  }, []);
  const cancelRecording = useCallback(() => {
    recordingRef.current = null;
    voice.cancelRecording();
  }, [voice]);

  useEffect(() => {
    let disposed = false;
    const unsubscribe: Array<() => void> = [];
    const install = async () => {
      const stateListener = await listen<DesktopPetSnapshot>(PET_EVENTS.state, ({ payload }) => {
        if (disposed) return;
        const previousKey = targetKey(snapshotRef.current);
        const previousSession = snapshotRef.current.hostSessionId;
        const sessionChanged = Boolean(previousSession && payload.hostSessionId && previousSession !== payload.hostSessionId);
        const nextKey = targetKey(payload);
        snapshotRef.current = payload;
        if (previousKey !== nextKey) {
          cancelRecording();
          voice.stopSpeaking();
          setReplyToRead(null);
          const text = nextKey ? readLocal(draftKey(nextKey)) : '';
          draftRef.current = text;
          setDraft(text);
        }
        if (sessionChanged) {
          cancelRecording();
          voice.stopSpeaking();
          setReplyToRead(null);
          if (sendFlightRef.current) {
            setNotice(t('主窗口已重新加载，请先在发送记录核实这条消息。', 'The main window reloaded. Check Send Records before resending this message.'));
          }
          sendFlightRef.current = null;
          setSendFlight(null);
        }
        setSnapshot(payload);
      });
      if (disposed) { stateListener(); return; }
      unsubscribe.push(stateListener);
      const resultListener = await listen<DesktopPetResult>(PET_EVENTS.result, ({ payload }) => {
        if (disposed) return;
        const queued = payload.queuedDraft;
        if (queued) {
          const key = queued.deviceId + ':' + queued.botId;
          if (readLocal(draftKey(key)) === queued.text) writeLocal(draftKey(key), '');
          if (targetKey(snapshotRef.current) === key && draftRef.current === queued.text) {
            draftRef.current = '';
            setDraft('');
          }
        }
        const flight = sendFlightRef.current;
        if (flight?.id === payload.id) {
          sendFlightRef.current = null;
          setSendFlight(null);
          if (payload.ok || payload.pendingId) {
            // Clear only the exact draft that was queued; preserve subsequent editing.
            if (readLocal(draftKey(flight.key)) === flight.text) writeLocal(draftKey(flight.key), '');
            if (targetKey(snapshotRef.current) === flight.key && draftRef.current === flight.text) {
              draftRef.current = '';
              setDraft('');
            }
            if (payload.ok) setReplyToRead(flight);
          }
        }
        if (payload.message) setNotice(payload.message);
        else if (!payload.ok) setNotice(t('操作未完成，请打开主窗口查看。', 'Open the main window to check this action.'));
      });
      if (disposed) { resultListener(); return; }
      unsubscribe.push(resultListener);
      const windowListener = await listen<DesktopPetWindowState>(PET_EVENTS.window, ({ payload }) => {
        if (disposed) return;
        setExpanded(payload.expanded);
        if (!payload.visible) { cancelRecording(); voice.stopSpeaking(); }
      });
      if (disposed) { windowListener(); return; }
      unsubscribe.push(windowListener);
      const windowState = await petWindow('status');
      if (disposed) return;
      setExpanded(windowState.expanded);
      await postAction({ id: crypto.randomUUID(), kind: 'ready' });
    };
    void install().catch(report);
    return () => { disposed = true; unsubscribe.forEach((stop) => stop()); };
  }, [cancelRecording, report, t, voice]);

  useEffect(() => () => { voice.dispose(); }, [voice]);
  useEffect(() => {
    const visibility = () => setPageVisible(!document.hidden);
    const theme = () => {
      const value = readLocal('desktop-theme');
      document.documentElement.dataset.theme = value === 'dark' || value === 'light' ? value : 'system';
    };
    theme();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('storage', theme);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('storage', theme);
    };
  }, []);

  const setWindowExpanded = useCallback(async (next: boolean) => {
    if (!next) { cancelRecording(); setSettingsOpen(false); }
    const state = await petWindow('set-expanded', next);
    setExpanded(state.expanded);
    if (state.expanded) await postAction({ id: crypto.randomUUID(), kind: 'refresh' });
  }, [cancelRecording]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (recordingRef.current || voiceStatus.phase === 'transcribing') cancelRecording();
      else if (voiceStatus.phase === 'speaking') voice.stopSpeaking();
      else if (settingsOpen) setSettingsOpen(false);
      else if (expanded) void setWindowExpanded(false).catch(report);
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [cancelRecording, expanded, report, setWindowExpanded, settingsOpen, voice, voiceStatus.phase]);
  useEffect(() => {
    if (expanded && !settingsOpen) composerRef.current?.focus();
  }, [expanded, settingsOpen]);
  useEffect(() => {
    const panel = transcriptRef.current;
    if (panel && pinnedRef.current) panel.scrollTop = panel.scrollHeight;
  }, [snapshot.messages, snapshot.streamingText, expanded]);

  const sendText = useCallback(async (text: string, expectedKey = targetKey(snapshotRef.current)) => {
    const state = snapshotRef.current;
    if (!text.trim() || sendFlightRef.current) return;
    if (expectedKey !== targetKey(state) || !state.deviceId || !state.botId || state.connection !== 'ready') {
      setNotice(t('连接已变化，内容保留在草稿中。', 'The connection changed. Your draft is preserved.'));
      return;
    }
    const flight = {
      id: crypto.randomUUID(), key: expectedKey, text,
      assistantIds: new Set(state.messages.filter((item) => item.role === 'assistant').map((item) => item.id)),
    };
    sendFlightRef.current = flight;
    setSendFlight(flight);
    setNotice('');
    voice.stopSpeaking();
    try {
      await postAction({ id: flight.id, kind: 'send', text, deviceId: state.deviceId, botId: state.botId });
    } catch (error) {
      if (sendFlightRef.current === flight) { sendFlightRef.current = null; setSendFlight(null); }
      report(error);
    }
  }, [report, t, voice]);

  useEffect(() => {
    if (!replyToRead) return;
    if (!autoRead || targetKey(snapshot) !== replyToRead.key) { setReplyToRead(null); return; }
    if (snapshot.connection !== 'ready' || isBotActivityBusy(snapshot.activity) || snapshot.streamingText ||
        voiceStatus.phase === 'recording' || voiceStatus.phase === 'transcribing') return;
    const reply = [...snapshot.messages].reverse().find((item) =>
      item.role === 'assistant' && item.text.trim() && !replyToRead.assistantIds.has(item.id),
    );
    if (reply) {
      setReplyToRead(null);
      void voice.speak(reply.text).catch(report);
    }
  }, [autoRead, replyToRead, report, snapshot, voice, voiceStatus.phase]);

  const beginRecording = () => {
    if (recordingRef.current || sendFlightRef.current || snapshotRef.current.connection !== 'ready') return;
    setNotice('');
    setReplyToRead(null);
    voice.stopSpeaking();
    const recording = {
      key: targetKey(snapshotRef.current), start: voice.startRecording(), released: false,
    };
    recordingRef.current = recording;
    void recording.start.catch((error: unknown) => {
      if (recordingRef.current === recording) { recordingRef.current = null; report(error); }
    });
  };
  const finishRecording = async () => {
    const recording = recordingRef.current;
    if (!recording || recording.released) return;
    recording.released = true;
    try {
      await recording.start;
      if (recordingRef.current !== recording) return;
      const text = (await voice.finishRecording()).trim();
      if (!text) { if (recordingRef.current === recording) recordingRef.current = null; return; }
      const stillCurrent = recording.key === targetKey(snapshotRef.current);
      if (recordingRef.current !== recording && stillCurrent) return;
      if (recordingRef.current === recording) recordingRef.current = null;
      const existing = stillCurrent ? draftRef.current : readLocal(draftKey(recording.key));
      const combined = existing.trim() ? existing + '\n' + text : text;
      changeDraft(combined, recording.key);
      if (recording.key === targetKey(snapshotRef.current)) await sendText(combined, recording.key);
      else setNotice(t('Bot 已变化，转写保留在原草稿中。', 'The bot changed. The transcript stays in its original draft.'));
    } catch (error) {
      if (recordingRef.current === recording) { recordingRef.current = null; report(error); }
    }
  };

  const busy = isBotActivityBusy(snapshot.activity);
  const recording = voiceStatus.phase === 'recording';
  const transcribing = voiceStatus.phase === 'transcribing';
  const speaking = voiceStatus.phase === 'speaking';
  const connectionText = snapshot.connection === 'ready' ? botActivityText(snapshot.activity, t)
    : snapshot.connection === 'connecting' ? t('连接中', 'Connecting')
    : snapshot.connection === 'unconfigured' ? t('请先连接本机 Bot', 'Connect the local bot')
    : t('已离线', 'Offline');
  const statusText = recording ? t('正在听，松开发送', 'Listening · release to send')
    : transcribing ? t('正在转写', 'Transcribing')
    : speaking ? t('正在朗读', 'Speaking') : connectionText;
  const avatar = snapshot.avatar ?? getDefaultBotAvatarPreset(targetKey(snapshot), snapshot.botName, true);
  const mascotState = recording ? 'listening' : transcribing ? 'thinking' : speaking ? 'dictating' : snapshot.mascotState;
  const message = notice || voiceStatus.error || snapshot.error;
  const canSend = snapshot.connection === 'ready' && !sendFlight && !snapshot.sending && !recording && !transcribing;

  return (
    <main className="pet-stage" aria-label={t('PiBot 桌宠', 'PiBot desktop pet')}>
      {expanded && (
        <section className="pet-chat" aria-label={t('与本机 main bot 对话', 'Chat with this computer’s main bot')}>
          {settingsOpen ? <VoiceSettings onClose={() => setSettingsOpen(false)} /> : <>
            <header className="pet-header">
              <div className="pet-heading"><strong>{snapshot.botName}</strong><span>{t('本机 main bot', 'Local main bot')}</span></div>
              <button className="pet-icon" title={t('打开主窗口', 'Open main window')} aria-label={t('打开主窗口', 'Open main window')}
                onClick={() => void petWindow('show-main').catch(report)}><ExternalLink size={16} /></button>
              <button className="pet-icon" title={t('语音设置', 'Voice settings')} aria-label={t('语音设置', 'Voice settings')}
                onClick={() => { cancelRecording(); voice.stopSpeaking(); setSettingsOpen(true); }}><Settings2 size={16} /></button>
              <button className="pet-icon" title={t('收起对话', 'Collapse chat')} aria-label={t('收起对话', 'Collapse chat')}
                onClick={() => void setWindowExpanded(false).catch(report)}><ChevronDown size={18} /></button>
            </header>
            <div className="pet-transcript" ref={transcriptRef} role="log" aria-live="off"
              onScroll={(event) => { const el = event.currentTarget; pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
              {!snapshot.messages.length && !snapshot.streamingText && (
                <div className="pet-empty">
                  <strong>{t('随时说两句', 'A small place to talk')}</strong>
                  <p>{snapshot.connection === 'ready'
                    ? t('输入消息，或按住麦克风说话。', 'Type a message, or hold the microphone to speak.')
                    : t('连接本机 main bot 后即可对话。', 'Connect this computer’s main bot to start chatting.')}</p>
                </div>
              )}
              {snapshot.messages.map((item) => (
                <article className={'pet-message pet-message-' + item.role} key={item.id}>
                  <div className="pet-message-text">{item.text}</div>
                  {item.role === 'assistant' && <button className="pet-read" title={t('朗读这条回复', 'Read this reply')}
                    aria-label={t('朗读这条回复', 'Read this reply')} onClick={() => { cancelRecording(); setReplyToRead(null); voice.stopSpeaking(); void voice.speak(item.text).catch(report); }}>
                    <Volume2 size={13} />
                  </button>}
                </article>
              ))}
              {snapshot.streamingText && <article className="pet-message pet-message-assistant pet-streaming">
                <div className="pet-message-text">{snapshot.streamingText}</div>
              </article>}
            </div>
            {message && <div className="pet-notice" role="status">{message}</div>}
            {snapshot.connection !== 'ready' && <div className="pet-reconnect">
              <button onClick={() => void postAction({ id: crypto.randomUUID(), kind: 'refresh' }).catch(report)}><RefreshCw size={13} />{t('刷新', 'Refresh')}</button>
              <button onClick={() => void petWindow('show-main').catch(report)}>{t('打开主窗口', 'Open main window')}</button>
            </div>}
            <form className="pet-composer" onSubmit={(event) => { event.preventDefault(); if (canSend) void sendText(draft); }}>
              <textarea ref={composerRef} rows={2} value={draft}
                aria-label={t('发送给本机 main bot 的消息', 'Message to the local main bot')}
                placeholder={t('聊点什么…', 'Say something…')} disabled={!snapshot.botId}
                onChange={(event) => changeDraft(event.target.value)}
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={() => { composingRef.current = false; }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !composingRef.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                    event.preventDefault(); if (canSend) void sendText(draft);
                  }
                }} />
              <div className="pet-composer-actions">
                <button type="button" className={'pet-mic' + (recording ? ' active' : '')}
                  disabled={!canSend && !recording} aria-label={t('按住说话，松开发送', 'Hold to speak, release to send')}
                  title={t('按住说话，松开发送；Esc 取消', 'Hold to speak, release to send; Esc cancels')}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); beginRecording();
                  }}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                    void finishRecording();
                  }}
                  onPointerCancel={cancelRecording}
                  onBlur={() => { if (recordingRef.current && !recordingRef.current.released) cancelRecording(); }}
                  onKeyDown={(event) => {
                    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); beginRecording(); }
                  }}
                  onKeyUp={(event) => {
                    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); void finishRecording(); }
                  }}><Mic size={16} /><span>{recording ? t('松开发送', 'Release') : t('按住说话', 'Hold to talk')}</span></button>
                <button type="button" className={'pet-icon' + (autoRead ? ' selected' : '')}
                  aria-pressed={autoRead} aria-label={t('自动朗读桌宠回复', 'Read pet replies aloud')}
                  title={t('自动朗读桌宠回复', 'Read pet replies aloud')}
                  onClick={() => { const next = !autoRead; setAutoRead(next); writeLocal(AUTO_READ_KEY, String(next)); if (!next) voice.stopSpeaking(); }}>
                  {autoRead ? <Volume2 size={16} /> : <VolumeX size={16} />}
                </button>
                {speaking && <button type="button" className="pet-icon" title={t('停止朗读', 'Stop reading')}
                  aria-label={t('停止朗读', 'Stop reading')} onClick={() => voice.stopSpeaking()}><Square size={13} /></button>}
                <span className="pet-action-spacer" />
                {snapshot.canStop && <button type="button" className="pet-icon pet-stop"
                  title={t('停止 Bot 当前任务', 'Stop bot task')} aria-label={t('停止 Bot 当前任务', 'Stop bot task')}
                  onClick={() => {
                    const state = snapshotRef.current;
                    if (state.deviceId && state.botId) void postAction({
                      id: crypto.randomUUID(), kind: 'stop', deviceId: state.deviceId, botId: state.botId,
                    }).catch(report);
                  }}><Square size={14} /></button>}
                <button type="submit" className="pet-send" disabled={!canSend || !draft.trim()}
                  title={t('发送', 'Send')} aria-label={t('发送', 'Send')}><ArrowUp size={18} /></button>
              </div>
            </form>
          </>}
        </section>
      )}
      <div className="pet-dock">
        <button className="pet-close" title={t('隐藏桌宠', 'Hide pet')} aria-label={t('隐藏桌宠', 'Hide pet')}
          onClick={() => { cancelRecording(); voice.stopSpeaking(); void petWindow('hide').catch(report); }}><X size={13} /></button>
        <button className="pet-avatar" aria-expanded={expanded} aria-label={t('点击对话，拖动移动桌宠', 'Click to chat, drag to move pet')}
          title={snapshot.botName + ' · ' + statusText}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            suppressClickRef.current = false;
            pointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const pointer = pointerRef.current;
            if (!pointer || pointer.id !== event.pointerId || pointer.dragged) return;
            if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6) return;
            pointer.dragged = true; suppressClickRef.current = true;
            event.currentTarget.releasePointerCapture(event.pointerId);
            void petWindow('drag').catch(report);
          }}
          onPointerUp={() => { pointerRef.current = null; }}
          onPointerCancel={() => { pointerRef.current = null; }}
          onKeyDown={() => { suppressClickRef.current = false; }}
          onClick={() => {
            if (suppressClickRef.current) { suppressClickRef.current = false; return; }
            void setWindowExpanded(!expanded).catch(report);
          }}>
          <GrokBotAnimatedMark seedId={targetKey(snapshot) || 'desktop-pet'} shape={avatar.shape} color={avatar.color}
            state={mascotState} size={96} maxFrameRate={30}
            isPlaying={pageVisible && (busy || recording || transcribing || speaking)}
            isStatic={!busy && !recording && !transcribing && !speaking} />
        </button>
        <div className={'pet-status' + (busy ? ' busy' : '')} title={statusText} role="status">
          <span className={'pet-status-dot ' + snapshot.connection} />{statusText}
        </div>
      </div>
    </main>
  );
}
