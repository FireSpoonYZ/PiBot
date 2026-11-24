import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp, ChevronDown, ChevronUp, ExternalLink, Mic, RefreshCw, Settings2, Square, Volume2, VolumeX, X,
} from 'lucide-react';
import { GrokBotAnimatedMark, resolveBotAvatarPreset } from '../../../../web/src/GrokBotAvatar';
import { botActivityText, isBotActivityBusy } from '../../../../web/src/botActivity';
import { classifyMarkdownLink } from '../../../../web/src/markdownLink';
import { useText } from '../../../../web/src/ui';
import {
  INITIAL_PET_SNAPSHOT, PET_EVENTS,
  type DesktopPetAction, type DesktopPetResult, type DesktopPetSnapshot,
  type DesktopPetWindowState, type PetDockSide, type PetPanelSide,
} from './protocol';
import { resolvePetTheme } from './theme';
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
type WindowLayout = { dockSide: PetDockSide; panelSide: PetPanelSide; composited: boolean };

const PetMarkdown = memo(function PetMarkdown({
  text,
  onCopyLink,
}: {
  text: string;
  onCopyLink: (value: string, kind: 'web' | 'host-path') => void;
}) {
  return (
    <div className="pet-md">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const link = classifyMarkdownLink(href);
            if (!link) return <>{children}</>;
            const value = link.kind === 'web' ? link.href : link.path;
            return (
              <button
                type="button"
                className="pet-md-link"
                title={value}
                onClick={() => onCopyLink(value, link.kind)}
              >
                {children}
              </button>
            );
          },
          img: ({ alt }) => <span className="pet-md-img">{alt || ''}</span>,
          pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
          table: ({ children }) => <div className="pet-md-table"><table>{children}</table></div>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export function PetApp() {
  const t = useText();
  const [snapshot, setSnapshot] = useState(INITIAL_PET_SNAPSHOT);
  const snapshotRef = useRef(snapshot);
  const [expanded, setExpanded] = useState(false);
  const [layout, setLayout] = useState<WindowLayout>({
    dockSide: 'right',
    panelSide: 'top',
    composited: true,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const [notice, setNotice] = useState('');
  const [sendFlight, setSendFlight] = useState<SendFlight | null>(null);
  const sendFlightRef = useRef<SendFlight | null>(null);
  const [autoRead, setAutoRead] = useState(() => readLocal(AUTO_READ_KEY) === 'true');
  const [replyToRead, setReplyToRead] = useState<SendFlight | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const speakTokenRef = useRef(0);
  const [voiceStatus, setVoiceStatus] = useState<PetVoiceStatus>({ phase: 'idle' });
  const [voice] = useState(() => createPetVoice({ onState: setVoiceStatus }));
  const recordingRef = useRef<Recording | null>(null);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const headerPointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const avatarPressValidRef = useRef(false);

  const report = useCallback((error: unknown) => setNotice(voiceError(error)), []);
  const applyWindowState = useCallback((state: DesktopPetWindowState) => {
    setExpanded(state.expanded);
    setLayout((prev) => ({
      dockSide: state.dockSide ?? prev.dockSide,
      panelSide: state.panelSide ?? prev.panelSide,
      composited: state.composited ?? prev.composited,
    }));
  }, []);

  const stopReading = useCallback(() => {
    speakTokenRef.current += 1;
    setSpeakingMessageId(null);
    voice.stopSpeaking();
  }, [voice]);

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

  const speakMessage = useCallback((id: string, text: string) => {
    cancelRecording();
    setReplyToRead(null);
    stopReading();
    const token = ++speakTokenRef.current;
    setSpeakingMessageId(id);
    void voice.speak(text)
      .catch(report)
      .finally(() => {
        if (speakTokenRef.current === token) setSpeakingMessageId(null);
      });
  }, [cancelRecording, report, stopReading, voice]);

  const copyMarkdownLink = useCallback((value: string, kind: 'web' | 'host-path') => {
    const doneMessage = kind === 'web'
      ? t('已复制链接，可在浏览器打开。', 'Link copied to clipboard.')
      : t('已复制 Host 路径。', 'Host path copied to clipboard.');
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(value).then(
        () => setNotice(doneMessage),
        () => setNotice(value),
      );
    } else {
      setNotice(value);
    }
  }, [t]);

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
          stopReading();
          setReplyToRead(null);
          const text = nextKey ? readLocal(draftKey(nextKey)) : '';
          draftRef.current = text;
          setDraft(text);
        }
        if (sessionChanged) {
          cancelRecording();
          stopReading();
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
        applyWindowState(payload);
        if (!payload.visible) { cancelRecording(); stopReading(); }
      });
      if (disposed) { windowListener(); return; }
      unsubscribe.push(windowListener);
      const windowState = await petWindow('status');
      if (disposed) return;
      applyWindowState(windowState);
      await postAction({ id: crypto.randomUUID(), kind: 'ready' });
    };
    void install().catch(report);
    return () => { disposed = true; unsubscribe.forEach((stop) => stop()); };
  }, [applyWindowState, cancelRecording, report, stopReading, t]);

  useEffect(() => () => { voice.dispose(); }, [voice]);
  useEffect(() => {
    const visibility = () => setPageVisible(!document.hidden);
    const mql = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    const syncTheme = () => {
      const stored = readLocal('desktop-theme') || readLocal('pibot.ui-theme.v1');
      const { theme, resolved } = resolvePetTheme(stored || null, Boolean(mql?.matches));
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = resolved;
    };
    syncTheme();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('storage', syncTheme);
    if (mql?.addEventListener) mql.addEventListener('change', syncTheme);
    else if (mql?.addListener) mql.addListener(syncTheme);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('storage', syncTheme);
      if (mql?.removeEventListener) mql.removeEventListener('change', syncTheme);
      else if (mql?.removeListener) mql.removeListener(syncTheme);
    };
  }, []);

  const setWindowExpanded = useCallback(async (next: boolean) => {
    if (!next) { cancelRecording(); setSettingsOpen(false); }
    const state = await petWindow('set-expanded', next);
    applyWindowState(state);
    if (state.expanded) await postAction({ id: crypto.randomUUID(), kind: 'refresh' });
  }, [applyWindowState, cancelRecording]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (recordingRef.current || voiceStatus.phase === 'transcribing') cancelRecording();
      else if (voiceStatus.phase === 'speaking') stopReading();
      else if (settingsOpen) setSettingsOpen(false);
      else if (expanded) void setWindowExpanded(false).catch(report);
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [cancelRecording, expanded, report, setWindowExpanded, settingsOpen, stopReading, voiceStatus.phase]);
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
    stopReading();
    try {
      await postAction({ id: flight.id, kind: 'send', text, deviceId: state.deviceId, botId: state.botId });
    } catch (error) {
      if (sendFlightRef.current === flight) { sendFlightRef.current = null; setSendFlight(null); }
      report(error);
    }
  }, [report, stopReading, t]);

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
      speakMessage(reply.id, reply.text);
    }
  }, [autoRead, replyToRead, snapshot, speakMessage, voiceStatus.phase]);

  const beginRecording = () => {
    if (recordingRef.current || sendFlightRef.current || snapshotRef.current.connection !== 'ready') return;
    setNotice('');
    setReplyToRead(null);
    stopReading();
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
    : snapshot.connection === 'unconfigured' ? t('请先连接本机主助手', 'Connect the local main bot')
    : t('已离线', 'Offline');
  const statusText = recording ? t('正在听，松开发送', 'Listening · release to send')
    : transcribing ? t('正在转写', 'Transcribing')
    : speaking ? t('正在朗读', 'Speaking') : connectionText;
  const avatar = snapshot.avatar ?? resolveBotAvatarPreset(targetKey(snapshot), snapshot.botName, true);
  const mascotState = recording ? 'listening' : transcribing ? 'thinking' : speaking ? 'dictating' : snapshot.mascotState;
  const message = notice || voiceStatus.error || snapshot.error;
  const canSend = snapshot.connection === 'ready' && !sendFlight && !snapshot.sending && !recording && !transcribing;

  return (
    <main
      className="pet-stage"
      data-expanded={expanded ? 'true' : 'false'}
      data-dock-side={layout.dockSide}
      data-panel-side={layout.panelSide}
      data-composited={layout.composited ? 'true' : 'false'}
      aria-label={t('PiBot 桌宠', 'PiBot desktop pet')}
    >
      {expanded && (
        <section className="pet-chat" aria-label={t('与本机主助手对话', "Chat with this computer's main bot")}>
          {settingsOpen ? <VoiceSettings onClose={() => setSettingsOpen(false)} /> : <>
            <header
              className="pet-header"
              onPointerDown={(event) => {
                if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
                headerPointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const pointer = headerPointerRef.current;
                if (!pointer || pointer.id !== event.pointerId) return;
                if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6) return;
                headerPointerRef.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                void petWindow('drag').catch(report);
              }}
              onPointerUp={() => { headerPointerRef.current = null; }}
              onPointerCancel={() => { headerPointerRef.current = null; }}
              onLostPointerCapture={() => { headerPointerRef.current = null; }}
            >
              <div className="pet-heading">
                <strong>{snapshot.botName}</strong>
                <span>{t('本机主助手', 'Local main bot')}</span>
              </div>
              <button type="button" className="pet-icon" title={t('打开主窗口', 'Open main window')} aria-label={t('打开主窗口', 'Open main window')}
                onClick={() => void petWindow('show-main').catch(report)}><ExternalLink size={16} /></button>
              <button type="button" className="pet-icon" title={t('语音设置', 'Voice settings')} aria-label={t('语音设置', 'Voice settings')}
                onClick={() => { cancelRecording(); stopReading(); setSettingsOpen(true); }}><Settings2 size={16} /></button>
              <button type="button" className="pet-icon" title={t('收起对话', 'Collapse chat')} aria-label={t('收起对话', 'Collapse chat')}
                onClick={() => void setWindowExpanded(false).catch(report)}>
                {layout.panelSide === 'bottom' ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </button>
            </header>
            <div className="pet-transcript" ref={transcriptRef} role="log" aria-live="off"
              onScroll={(event) => { const el = event.currentTarget; pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
              {!snapshot.messages.length && !snapshot.streamingText && (
                <div className="pet-empty">
                  <strong>{t('随时说两句', 'A small place to talk')}</strong>
                  <p>{snapshot.connection === 'ready'
                    ? t('输入消息，或按住麦克风说话。', 'Type a message, or hold the microphone to speak.')
                    : t('连接本机主助手后即可对话。', "Connect this computer's main bot to start chatting.")}</p>
                </div>
              )}
              {snapshot.messages.map((item) => {
                const isReadingThis = speaking && speakingMessageId === item.id;
                return (
                  <article className={'pet-message pet-message-' + item.role} key={item.id}>
                    {item.role === 'assistant'
                      ? <PetMarkdown text={item.text} onCopyLink={copyMarkdownLink} />
                      : <div className="pet-message-text">{item.text}</div>}
                    {item.role === 'assistant' && (
                      <button
                        type="button"
                        className={'pet-read' + (isReadingThis ? ' active' : '')}
                        title={isReadingThis ? t('停止朗读', 'Stop reading') : t('朗读这条回复', 'Read this reply')}
                        aria-label={isReadingThis ? t('停止朗读', 'Stop reading') : t('朗读这条回复', 'Read this reply')}
                        aria-pressed={isReadingThis}
                        onClick={() => {
                          if (isReadingThis) stopReading();
                          else speakMessage(item.id, item.text);
                        }}
                      >
                        {isReadingThis ? <VolumeX size={13} /> : <Volume2 size={13} />}
                      </button>
                    )}
                  </article>
                );
              })}
              {snapshot.streamingText && (
                <article className="pet-message pet-message-assistant pet-streaming">
                  <PetMarkdown text={snapshot.streamingText} onCopyLink={copyMarkdownLink} />
                </article>
              )}
            </div>
            {message && <div className="pet-notice" role="status">{message}</div>}
            {snapshot.connection !== 'ready' && <div className="pet-reconnect">
              <button type="button" onClick={() => void postAction({ id: crypto.randomUUID(), kind: 'refresh' }).catch(report)}><RefreshCw size={13} />{t('刷新', 'Refresh')}</button>
              <button type="button" onClick={() => void petWindow('show-main').catch(report)}>{t('打开主窗口', 'Open main window')}</button>
            </div>}
            <form className="pet-composer" onSubmit={(event) => { event.preventDefault(); if (canSend) void sendText(draft); }}>
              <textarea ref={composerRef} rows={2} value={draft}
                aria-label={t('发送给本机主助手的消息', 'Message to the local main bot')}
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
                  onClick={() => { const next = !autoRead; setAutoRead(next); writeLocal(AUTO_READ_KEY, String(next)); if (!next) stopReading(); }}>
                  {autoRead ? <Volume2 size={16} /> : <VolumeX size={16} />}
                </button>
                {speaking && (
                  <button type="button" className="pet-stop-audio" title={t('停止朗读', 'Stop reading')}
                    aria-label={t('停止朗读', 'Stop reading')} onClick={stopReading}>
                    <VolumeX size={13} /><span>{t('停读', 'Mute')}</span>
                  </button>
                )}
                <span className="pet-action-spacer" />
                {snapshot.canStop && (
                  <button type="button" className="pet-stop"
                    title={t('停止 Bot 当前任务', 'Stop bot task')} aria-label={t('停止 Bot 当前任务', 'Stop bot task')}
                    onClick={() => {
                      const state = snapshotRef.current;
                      if (state.deviceId && state.botId) void postAction({
                        id: crypto.randomUUID(), kind: 'stop', deviceId: state.deviceId, botId: state.botId,
                      }).catch(report);
                    }}>
                    <Square size={10} fill="currentColor" /><span>{t('停止', 'Stop')}</span>
                  </button>
                )}
                <button type="submit" className="pet-send" disabled={!canSend || !draft.trim()}
                  title={t('发送', 'Send')} aria-label={t('发送', 'Send')}><ArrowUp size={18} /></button>
              </div>
            </form>
          </>}
        </section>
      )}
      <div className="pet-dock">
        {!expanded && (
          <button type="button" className="pet-close" title={t('隐藏桌宠', 'Hide pet')} aria-label={t('隐藏桌宠', 'Hide pet')}
            onClick={() => { cancelRecording(); stopReading(); void petWindow('hide').catch(report); }}>
            <X size={13} />
          </button>
        )}
        <button type="button" className="pet-avatar" aria-expanded={expanded}
          aria-label={t('点击对话，拖动移动桌宠', 'Click to chat, drag to move pet') + ' · ' + snapshot.botName + ' · ' + statusText}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            avatarPressValidRef.current = true;
            pointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const pointer = pointerRef.current;
            if (!pointer || pointer.id !== event.pointerId) return;
            if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6) return;
            pointerRef.current = null;
            avatarPressValidRef.current = false;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            void petWindow('drag').catch(report);
          }}
          onPointerUp={() => { pointerRef.current = null; }}
          onPointerCancel={() => { pointerRef.current = null; avatarPressValidRef.current = false; }}
          onLostPointerCapture={() => { pointerRef.current = null; }}
          onClick={(event) => {
            // Require a non-dragged press for pointer clicks; keyboard/AT-SPI clicks have detail === 0.
            if (event.detail > 0 && !avatarPressValidRef.current) return;
            avatarPressValidRef.current = false;
            void setWindowExpanded(!expanded).catch(report);
          }}>
          <GrokBotAnimatedMark seedId={targetKey(snapshot) || 'desktop-pet'} shape={avatar.shape} color={avatar.color}
            state={mascotState} size={94} maxFrameRate={30}
            isPlaying={pageVisible && (busy || recording || transcribing || speaking)}
            isStatic={!busy && !recording && !transcribing && !speaking} />
        </button>
        <div className={'pet-status' + (busy ? ' busy' : '')} title={statusText} role="status">
          <span className={'pet-status-dot ' + snapshot.connection} />
          <span className="pet-status-text">{statusText}</span>
        </div>
      </div>
    </main>
  );
}
