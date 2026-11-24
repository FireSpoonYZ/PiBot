import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ArrowUp,
  Bell,
  CheckCircle2,
  Circle,
  CircleDot,
  ClipboardList,
  ExternalLink,
  History,
  ListTodo,
  Mic,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { QuestionnairePresentation } from '../../../../host-core/index.js';
import { GrokBotAnimatedMark, resolveBotAvatarPreset } from '../../../../web/src/GrokBotAvatar';
import { botActivityText, isBotActivityBusy } from '../../../../web/src/botActivity';
import { classifyMarkdownLink } from '../../../../web/src/markdownLink';
import {
  ToolPresentationCard,
  type QuestionnaireSubmitPayload,
} from '../../../../web/src/ToolPresentation';
import { useText } from '../../../../web/src/ui';
import {
  INITIAL_PET_SNAPSHOT,
  PET_EVENTS,
  type DesktopPetAction,
  type DesktopPetResult,
  type DesktopPetSnapshot,
  type DesktopPetWindowState,
  type PetDockSide,
  type PetPanelSide,
  type PetProactiveAlert,
  type PetWindowHitRect,
} from './protocol';
import { resolvePetTheme } from './theme';
import { createPetVoice, voiceError, type PetVoiceStatus } from './voice';
import { VoiceSettings } from './VoiceSettings';
import { petWindow } from './windowApi';

const AUTO_READ_KEY = 'pibot-desktop-pet-auto-read:v1';
const AUTO_FADE_KEY = 'pibot-desktop-pet-auto-fade:v1';
const DND_KEY = 'pibot-desktop-pet-dnd:v1';
const COLLAPSED_W = 164;
const COLLAPSED_H = 128;
const MAX_STAGE_W = 520;
const MAX_STAGE_H = 640;
const STAGE_PAD = 12;
const AUTO_FADE_MS = 10_000;
const PROACTIVE_AUTO_TUCK_MS = 15_000;

function layoutRectRelativeTo(node: HTMLElement, ancestor: HTMLElement) {
  let left = 0;
  let top = 0;
  let el: HTMLElement | null = node;
  while (el && el !== ancestor) {
    left += el.offsetLeft - el.scrollLeft;
    top += el.offsetTop - el.scrollTop;
    el = el.offsetParent as HTMLElement | null;
  }
  return { left, top, width: node.offsetWidth, height: node.offsetHeight };
}

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
type PendingRpc = { resolve: (result: DesktopPetResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

type BubbleDescriptor =
  | { kind: 'menu'; id: 'menu' }
  | { kind: 'settings'; id: 'settings' }
  | { kind: 'voice'; id: string; text: string }
  | {
      kind: 'question';
      id: string;
      presentation: QuestionnairePresentation;
      interactive: boolean;
      interrupted?: boolean;
      settledReceipt?: boolean;
    }
  | {
      kind: 'handoff';
      id: string;
      title: string;
      detail: string;
      tone: 'attention' | 'info' | 'danger';
      badge: string;
      actionLabel?: string;
      showRefresh?: boolean;
    }
  | { kind: 'thought'; id: string; text: string; canStop: boolean }
  | { kind: 'speech'; id: string; text: string; streaming: boolean; promptQuote?: string; messageId?: string }
  | { kind: 'proactive-alert'; id: string; alert: PetProactiveAlert }
  | { kind: 'progress'; id: string };

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
  const [layout, setLayout] = useState<WindowLayout>({
    dockSide: 'right',
    panelSide: 'top',
    composited: true,
  });
  const [composerOpen, setComposerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ctxMenuOpen, setCtxMenuOpen] = useState(false);
  const [hoveringDock, setHoveringDock] = useState(false);
  const [hoveringBubble, setHoveringBubble] = useState(false);
  const [bubbleFocused, setBubbleFocused] = useState(false);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const [notice, setNotice] = useState('');
  const [sendFlight, setSendFlight] = useState<SendFlight | null>(null);
  const sendFlightRef = useRef<SendFlight | null>(null);
  const [autoRead, setAutoRead] = useState(() => readLocal(AUTO_READ_KEY) === 'true');
  const [autoFade, setAutoFade] = useState(() => readLocal(AUTO_FADE_KEY) === 'true');
  const [dndMode, setDndMode] = useState(() => readLocal(DND_KEY) === 'true');
  const [replyToRead, setReplyToRead] = useState<SendFlight | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const speakTokenRef = useRef(0);
  const [voiceStatus, setVoiceStatus] = useState<PetVoiceStatus>({ phase: 'idle' });
  const [voice] = useState(() => createPetVoice({ onState: setVoiceStatus }));
  const recordingRef = useRef<Recording | null>(null);
  const [pageVisible, setPageVisible] = useState(!document.hidden);

  // Bubble visibility & settlement tracking
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const [tuckedProactiveIds, setTuckedProactiveIds] = useState<Set<string>>(() => new Set());
  const [revealedProactiveId, setRevealedProactiveId] = useState<string | null>(null);
  const [forcedReplyId, setForcedReplyId] = useState<string | null>(null);
  const [recentQuestionId, setRecentQuestionId] = useState<string | null>(null);
  const initialReplyCapturedRef = useRef<string | null>(null);
  const pendingRpcRef = useRef<Map<string, PendingRpc>>(new Map());

  const stageRef = useRef<HTMLElement | null>(null);
  const envelopeRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const avatarPressValidRef = useRef(false);
  const lastLayoutKeyRef = useRef('');
  const focusPendingRef = useRef(false);

  const report = useCallback((error: unknown) => setNotice(voiceError(error)), []);

  const applyWindowState = useCallback((state: DesktopPetWindowState) => {
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

  const dismissBubble = useCallback((id: string) => {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    if (forcedReplyId === id) setForcedReplyId(null);
    if (id.startsWith('q:')) setRecentQuestionId(null);
    if (id === 'notice') setNotice('');
  }, [forcedReplyId]);

  const sendActionAwait = useCallback((action: DesktopPetAction): Promise<DesktopPetResult> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRpcRef.current.delete(action.id);
        reject(new Error(t('操作超时，请检查主窗口状态。', 'Action timed out. Check the main window.')));
      }, 30_000);
      pendingRpcRef.current.set(action.id, { resolve, reject, timer });
      void postAction(action).catch((error) => {
        const entry = pendingRpcRef.current.get(action.id);
        if (entry) {
          clearTimeout(entry.timer);
          pendingRpcRef.current.delete(action.id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }, [t]);

  // Listen to host state/result/window events
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

        if (payload.questionnaire?.presentation.requestId) {
          setRecentQuestionId(payload.questionnaire.presentation.requestId);
        }

        if (previousKey !== nextKey) {
          cancelRecording();
          stopReading();
          setReplyToRead(null);
          setRecentQuestionId(null);
          initialReplyCapturedRef.current = null;
          const text = nextKey ? readLocal(draftKey(nextKey)) : '';
          draftRef.current = text;
          setDraft(text);
        }

        // Capture existing latest assistant message ID on the first ready snapshot for each
        // target bot so opening the pet stays calm & ambient instead of popping old history.
        if (initialReplyCapturedRef.current === null && payload.connection === 'ready') {
          const lastAsst = [...payload.messages].reverse().find((m) => m.role === 'assistant');
          initialReplyCapturedRef.current = lastAsst ? `speech:${lastAsst.id}` : '';
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
        const rpc = pendingRpcRef.current.get(payload.id);
        if (rpc) {
          clearTimeout(rpc.timer);
          pendingRpcRef.current.delete(payload.id);
          if (payload.ok) rpc.resolve(payload);
          else rpc.reject(new Error(payload.message || t('操作未完成，请打开主窗口查看。', 'Action failed. Check the main window.')));
        }
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
            if (readLocal(draftKey(flight.key)) === flight.text) writeLocal(draftKey(flight.key), '');
            if (targetKey(snapshotRef.current) === flight.key && draftRef.current === flight.text) {
              draftRef.current = '';
              setDraft('');
            }
            if (payload.ok) setReplyToRead(flight);
          }
        }
        if (!rpc) {
          if (payload.message) setNotice(payload.message);
          else if (!payload.ok) setNotice(t('操作未完成，请打开主窗口查看。', 'Open the main window to check this action.'));
        }
      });
      if (disposed) { resultListener(); return; }
      unsubscribe.push(resultListener);

      const windowListener = await listen<DesktopPetWindowState>(PET_EVENTS.window, ({ payload }) => {
        if (disposed) return;
        applyWindowState(payload);
        if (!payload.visible) {
          cancelRecording();
          stopReading();
          setComposerOpen(false);
          setSettingsOpen(false);
          setCtxMenuOpen(false);
        }
      });
      if (disposed) { windowListener(); return; }
      unsubscribe.push(windowListener);

      const windowState = await petWindow('status');
      if (disposed) return;
      applyWindowState(windowState);
      await postAction({ id: crypto.randomUUID(), kind: 'ready' });
    };
    void install().catch(report);
    return () => {
      disposed = true;
      unsubscribe.forEach((stop) => stop());
      pendingRpcRef.current.forEach((entry) => {
        clearTimeout(entry.timer);
        entry.reject(new Error('Disposed'));
      });
      pendingRpcRef.current.clear();
    };
  }, [applyWindowState, cancelRecording, report, stopReading, t]);

  useEffect(() => () => { voice.dispose(); }, [voice]);

  // Theme & page visibility sync
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

  // Esc dismisses active transient layer cleanly
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (recordingRef.current || voiceStatus.phase === 'transcribing') cancelRecording();
      else if (voiceStatus.phase === 'speaking') stopReading();
      else if (ctxMenuOpen) setCtxMenuOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (composerOpen) setComposerOpen(false);
      else if (revealedProactiveId) {
        const tuckedId = revealedProactiveId;
        setRevealedProactiveId(null);
        setTuckedProactiveIds((prev) => {
          if (prev.has(tuckedId)) return prev;
          const next = new Set(prev);
          next.add(tuckedId);
          return next;
        });
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [cancelRecording, composerOpen, ctxMenuOpen, revealedProactiveId, settingsOpen, stopReading, voiceStatus.phase]);

  // Auto-focus composer textarea when user opens the floating composer pill
  useEffect(() => {
    if (composerOpen && !settingsOpen) {
      focusPendingRef.current = true;
      const timer = setTimeout(() => composerRef.current?.focus(), 40);
      return () => clearTimeout(timer);
    }
  }, [composerOpen, settingsOpen]);

  // Auto-grow composer textarea (1–3 lines)
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 72) + 'px';
  }, [draft, composerOpen]);

  // Close context menu when clicking outside
  useEffect(() => {
    if (!ctxMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest('.pet-ctx-menu')) {
        setCtxMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [ctxMenuOpen]);

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
    setForcedReplyId(null);
    setComposerOpen(false);
    stopReading();
    try {
      await postAction({ id: flight.id, kind: 'send', text, deviceId: state.deviceId, botId: state.botId });
    } catch (error) {
      if (sendFlightRef.current === flight) { sendFlightRef.current = null; setSendFlight(null); }
      report(error);
    }
  }, [report, stopReading, t]);

  const submitQuestionnaire = useCallback(async (input: QuestionnaireSubmitPayload): Promise<unknown> => {
    const state = snapshotRef.current;
    const activeQ = state.questionnaire;
    if (!state.deviceId || !state.botId || !activeQ) {
      throw new Error(t('问卷已失效或主助手尚未连接。', 'Questionnaire is no longer active.'));
    }
    const result = await sendActionAwait({
      id: crypto.randomUUID(),
      kind: 'answer-questionnaire',
      deviceId: state.deviceId,
      botId: state.botId,
      installationId: activeQ.presentation.installationId,
      input,
    });
    return result.data;
  }, [sendActionAwait, t]);

  // Auto-read TTS for completed replies initiated from pet
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
  const canSend = snapshot.connection === 'ready' && !sendFlight && !snapshot.sending && !recording && !transcribing;

  const latestReply = useMemo(() => {
    for (let i = snapshot.messages.length - 1; i >= 0; i -= 1) {
      const item = snapshot.messages[i];
      if (item.role === 'assistant' && item.text.trim()) {
        const prev = i > 0 && snapshot.messages[i - 1]?.role === 'user' ? snapshot.messages[i - 1].text : undefined;
        return { message: item, promptQuote: prev };
      }
    }
    return null;
  }, [snapshot.messages]);

  const latestUserText = useMemo(() => {
    for (let i = snapshot.messages.length - 1; i >= 0; i -= 1) {
      if (snapshot.messages[i].role === 'user' && snapshot.messages[i].text.trim()) {
        return snapshot.messages[i].text;
      }
    }
    return undefined;
  }, [snapshot.messages]);

  // Clear temporary settled questionnaire receipt automatically once Bot moves on or after 2.6s
  const matchingSettledQuestion = useMemo(() => {
    if (!recentQuestionId || snapshot.questionnaire) return null;
    if (snapshot.settledQuestionnaire?.requestId === recentQuestionId) {
      return snapshot.settledQuestionnaire;
    }
    return null;
  }, [recentQuestionId, snapshot.questionnaire, snapshot.settledQuestionnaire]);

  useEffect(() => {
    if (!matchingSettledQuestion) return;
    if (snapshot.streamingText) {
      setRecentQuestionId(null);
      return;
    }
    const timer = setTimeout(() => setRecentQuestionId(null), 2600);
    return () => clearTimeout(timer);
  }, [matchingSettledQuestion, snapshot.streamingText]);

  // Polymorphic bubble priority arbitration (single clean bubble at a time)
  const activeBubble = useMemo<BubbleDescriptor | null>(() => {
    if (ctxMenuOpen) {
      return { kind: 'menu', id: 'menu' };
    }
    if (settingsOpen) {
      return { kind: 'settings', id: 'settings' };
    }
    if (recording) {
      return { kind: 'voice', id: 'voice:rec', text: t('正在听你说话…松开发送', 'Listening… release to send') };
    }
    if (transcribing) {
      return { kind: 'voice', id: 'voice:stt', text: t('正在转写语音…', 'Transcribing…') };
    }

    // Priority 1: Active pending questionnaire (always pops up, even in DND)
    if (snapshot.questionnaire) {
      const qId = `q:${snapshot.questionnaire.presentation.requestId}`;
      if (!dismissedIds.has(qId)) {
        return {
          kind: 'question',
          id: qId,
          presentation: snapshot.questionnaire.presentation,
          interactive: snapshot.questionnaire.interactive,
          interrupted: snapshot.questionnaire.interrupted,
        };
      }
    }

    // Priority 1b: Brief settled receipt right after answering (in pet or main window)
    if (matchingSettledQuestion) {
      const qId = `q-done:${matchingSettledQuestion.requestId}`;
      if (!dismissedIds.has(qId)) {
        return {
          kind: 'question',
          id: qId,
          presentation: matchingSettledQuestion,
          interactive: false,
          settledReceipt: true,
        };
      }
    }

    // Priority 2: Security / browser / account handoff card (always pops up)
    if (snapshot.handoff && !dismissedIds.has(`handoff:${snapshot.handoff.id}`)) {
      const h = snapshot.handoff;
      return {
        kind: 'handoff',
        id: `handoff:${h.id}`,
        title: h.title,
        detail: h.detail,
        tone: h.tone,
        badge: h.kind === 'vault-unlock' ? t('安全接力', 'Security') : t('主窗口接力', 'Handoff'),
        actionLabel: h.actionLabel,
      };
    }

    // Priority 2b: Local error notice, or offline/unconfigured state after user clicks mascot
    const connError = snapshot.connection === 'ready' || composerOpen ? snapshot.error : null;
    const errText = notice || voiceStatus.error || connError;
    if (errText && !dismissedIds.has(`err:${errText}`)) {
      return {
        kind: 'handoff',
        id: `err:${errText}`,
        title: snapshot.connection === 'offline'
          ? t('本机主助手离线', 'Local main bot offline')
          : snapshot.connection === 'unconfigured'
            ? t('请先连接本机主助手', 'Connect local main bot')
            : t('提示', 'Notice'),
        detail: errText,
        tone: snapshot.connection === 'ready' ? 'attention' : 'danger',
        badge: snapshot.connection === 'ready' ? t('提示', 'Notice') : t('连接状态', 'Connection'),
        actionLabel: t('打开主窗口', 'Open main window'),
        showRefresh: snapshot.connection !== 'ready',
      };
    }

    // Priority 3: Live streaming reply
    if (snapshot.streamingText && !dndMode) {
      const sid = `stream:${snapshot.generationId ?? 'live'}`;
      if (!dismissedIds.has(sid)) {
        return {
          kind: 'speech',
          id: sid,
          text: snapshot.streamingText,
          streaming: true,
          promptQuote: latestUserText,
        };
      }
    }

    // Priority 4: Busy thinking / working thought bubble (or todo progress if available while busy)
    if (busy && !dndMode) {
      if (snapshot.todo && snapshot.todo.tasks.some((item) => item.status !== 'completed')) {
        const tid = `todo:${snapshot.todo.tasks.map((item) => `${item.id}:${item.status}`).join(',')}`;
        if (!dismissedIds.has(tid)) {
          return { kind: 'progress', id: tid };
        }
      }
      const thoughtLabel = snapshot.activeToolName
        ? t(`正在调用 ${snapshot.activeToolName}…`, `Running ${snapshot.activeToolName}…`)
        : botActivityText(snapshot.activity, t);
      return {
        kind: 'thought',
        id: 'thought:live',
        text: thoughtLabel,
        canStop: snapshot.canStop,
      };
    }

    // Priority 5: Latest assistant reply (only for newly arrived replies or user-recalled reply)
    if (latestReply) {
      const rid = `speech:${latestReply.message.id}`;
      const isFresh = initialReplyCapturedRef.current !== null && initialReplyCapturedRef.current !== rid;
      const isForced = forcedReplyId === rid;
      if ((isForced || (isFresh && !dndMode)) && !dismissedIds.has(rid)) {
        return {
          kind: 'speech',
          id: rid,
          text: latestReply.message.text,
          streaming: false,
          promptQuote: latestReply.promptQuote,
          messageId: latestReply.message.id,
        };
      }
    }

    // Priority 5b: Proactive Google assistant Board alert (below all active chat/handoff/speech bubbles)
    if (snapshot.proactiveAlert) {
      const alert = snapshot.proactiveAlert;
      const isRevealed = revealedProactiveId === alert.resultId;
      const isTucked = tuckedProactiveIds.has(alert.resultId);
      if (isRevealed || (!dndMode && !isTucked)) {
        return {
          kind: 'proactive-alert',
          id: `proactive:${alert.resultId}`,
          alert,
        };
      }
    }

    // Priority 6: Active Task / incomplete Todo card when idle
    if (!dndMode && (snapshot.task || (snapshot.todo && snapshot.todo.tasks.some((item) => item.status !== 'completed')))) {
      const pid = snapshot.task
        ? `task:${snapshot.task.taskId}:${snapshot.task.status}:${snapshot.task.stepCount.done}`
        : `todo-idle:${snapshot.todo?.tasks.length ?? 0}`;
      if (!dismissedIds.has(pid)) {
        return { kind: 'progress', id: pid };
      }
    }

    return null;
  }, [
    busy,
    composerOpen,
    ctxMenuOpen,
    dismissedIds,
    dndMode,
    forcedReplyId,
    latestReply,
    latestUserText,
    matchingSettledQuestion,
    notice,
    recording,
    revealedProactiveId,
    settingsOpen,
    snapshot,
    t,
    transcribing,
    tuckedProactiveIds,
    voiceStatus.error,
  ]);

  // Clear revealed proactive alert state when alert clears or rotates to a newer resultId
  useEffect(() => {
    if (revealedProactiveId && snapshot.proactiveAlert?.resultId !== revealedProactiveId) {
      setRevealedProactiveId(null);
    }
  }, [revealedProactiveId, snapshot.proactiveAlert]);

  useEffect(() => {
    if (!activeBubble) setBubbleFocused(false);
  }, [activeBubble]);

  // Auto-fade completed speech bubbles when user enabled auto-fade
  useEffect(() => {
    if (!autoFade || !activeBubble || activeBubble.kind !== 'speech' || activeBubble.streaming) return;
    if (hoveringBubble || speaking) return;
    const bubbleId = activeBubble.id;
    const timer = setTimeout(() => dismissBubble(bubbleId), AUTO_FADE_MS);
    return () => clearTimeout(timer);
  }, [activeBubble, autoFade, dismissBubble, hoveringBubble, speaking]);

  // Auto-tuck auto-opened proactive alert back into the mascot badge after 15s without hover/focus.
  // Auto-tuck is NOT dismissal: never dispatch dismiss-proactive-alert here.
  const activeProactiveAlertId =
    activeBubble?.kind === 'proactive-alert' ? activeBubble.alert.resultId : null;
  useEffect(() => {
    if (!activeProactiveAlertId) return;
    if (revealedProactiveId === activeProactiveAlertId || hoveringBubble || bubbleFocused) return;
    const timer = setTimeout(() => {
      setTuckedProactiveIds((prev) => {
        if (prev.has(activeProactiveAlertId)) return prev;
        const next = new Set(prev);
        next.add(activeProactiveAlertId);
        return next;
      });
    }, PROACTIVE_AUTO_TUCK_MS);
    return () => clearTimeout(timer);
  }, [activeProactiveAlertId, bubbleFocused, hoveringBubble, revealedProactiveId]);

  // Measure visible stage envelope & hit-test rectangles and sync to Rust native window.
  const syncNativeLayoutRef = useRef<() => void>(() => {});
  const syncNativeLayout = useCallback(() => {
    const env = envelopeRef.current;
    const stage = stageRef.current;
    if (!env || !stage) return;

    // Use unscaled offset dimensions (immune to CSS transform animations and LTR left-overflow).
    let contentW = env.offsetWidth;
    const contentH = env.offsetHeight;
    for (let i = 0; i < env.children.length; i += 1) {
      const child = env.children[i] as HTMLElement;
      if (child.offsetWidth > contentW) contentW = child.offsetWidth;
    }

    const envW = Math.ceil(contentW + STAGE_PAD * 2);
    const envH = Math.ceil(contentH + STAGE_PAD * 2);
    const hasOverlay = Boolean(activeBubble || composerOpen || ctxMenuOpen);
    const width = hasOverlay ? Math.min(MAX_STAGE_W, Math.max(COLLAPSED_W, envW)) : COLLAPSED_W;
    const height = hasOverlay ? Math.min(MAX_STAGE_H, Math.max(COLLAPSED_H, envH)) : COLLAPSED_H;

    // Only include hit-rects once the viewport has caught up to the target size,
    // preventing stale clipped regions while the window is still growing.
    const sizeMatches =
      Math.abs(stage.clientWidth - width) <= 4 && Math.abs(stage.clientHeight - height) <= 4;

    const hitRects: PetWindowHitRect[] = [];
    if (sizeMatches) {
      const nodes = stage.querySelectorAll<HTMLElement>('[data-pet-hit="true"]');
      nodes.forEach((node) => {
        const r = layoutRectRelativeTo(node, stage);
        if (r.width <= 1 || r.height <= 1) return;
        const pad = Number(node.dataset.petHitPad ?? '6');
        const radius = Number(node.dataset.petHitRadius ?? '16');
        const x = Math.max(0, Math.floor(r.left - pad));
        const y = Math.max(0, Math.floor(r.top - pad));
        const right = Math.min(stage.clientWidth, Math.ceil(r.left + r.width + pad));
        const bottom = Math.min(stage.clientHeight, Math.ceil(r.top + r.height + pad));
        if (right > x && bottom > y) {
          hitRects.push({ x, y, width: right - x, height: bottom - y, radius });
        }
      });
    }

    const shouldFocus = focusPendingRef.current;
    focusPendingRef.current = false;

    const key = JSON.stringify([
      width,
      height,
      shouldFocus,
      hitRects.map((r) => [r.x, r.y, r.width, r.height]),
    ]);
    if (key === lastLayoutKeyRef.current) return;
    lastLayoutKeyRef.current = key;

    void petWindow('set-layout', undefined, { width, height, focus: shouldFocus, hitRects })
      .then((nextState) => {
        applyWindowState(nextState);
        if (!sizeMatches) {
          requestAnimationFrame(() => syncNativeLayoutRef.current());
        }
      })
      .catch(() => { /* Window may be closing */ });
  }, [activeBubble, applyWindowState, composerOpen, ctxMenuOpen]);

  syncNativeLayoutRef.current = syncNativeLayout;

  useLayoutEffect(() => {
    const raf = requestAnimationFrame(syncNativeLayout);
    return () => cancelAnimationFrame(raf);
  }, [syncNativeLayout, hoveringDock, activeBubble, composerOpen, ctxMenuOpen, settingsOpen, draft, layout.dockSide, layout.panelSide]);

  useEffect(() => {
    const env = envelopeRef.current;
    const stage = stageRef.current;
    if (!env || typeof ResizeObserver !== 'function') return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => syncNativeLayoutRef.current());
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(env);
    if (stage) observer.observe(stage);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [syncNativeLayout]);

  const avatar = snapshot.avatar ?? resolveBotAvatarPreset(targetKey(snapshot), snapshot.botName, true);
  const mascotState = recording ? 'listening' : transcribing ? 'thinking' : speaking ? 'dictating' : snapshot.mascotState;
  const petMood = recording
    ? 'listening'
    : activeBubble?.kind === 'question' && activeBubble.interactive
      ? 'question'
      : activeBubble?.kind === 'handoff'
        ? 'handoff'
        : busy || transcribing
          ? 'thinking'
          : 'idle';
  const showDotBadge =
    snapshot.connection !== 'ready' ||
    recording ||
    Boolean(snapshot.questionnaire?.interactive) ||
    Boolean(snapshot.handoff) ||
    Boolean(snapshot.proactiveAlert);
  const dotTone = recording || snapshot.connection === 'offline'
    ? 'danger'
    : snapshot.questionnaire?.interactive
      ? 'primary'
      : 'attention';

  const canRecallReply = Boolean(latestReply && (!activeBubble || activeBubble.kind !== 'speech'));

  return (
    <main
      ref={stageRef}
      className="pet-stage"
      data-dock-side={layout.dockSide}
      data-panel-side={layout.panelSide}
      data-composited={layout.composited ? 'true' : 'false'}
      aria-label={t('PiBot 桌宠', 'PiBot desktop pet')}
    >
      <div className="pet-envelope" ref={envelopeRef}>
        {/* 1. POLYMORPHIC BUBBLE SLOT */}
        {activeBubble ? (
          <div
            className="pet-bubble-wrap"
            onPointerEnter={() => setHoveringBubble(true)}
            onPointerLeave={() => setHoveringBubble(false)}
            onFocus={() => setBubbleFocused(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setBubbleFocused(false);
              }
            }}
          >
            <section
              className="pet-bubble"
              data-variant={activeBubble.kind}
              data-tone={activeBubble.kind === 'handoff' ? activeBubble.tone : undefined}
              data-pet-hit="true"
              data-pet-hit-pad={activeBubble.kind === 'thought' || activeBubble.kind === 'voice' ? '18' : '14'}
              data-pet-hit-radius={activeBubble.kind === 'thought' || activeBubble.kind === 'voice' ? '24' : '18'}
              aria-label={t('桌宠气泡', 'Pet bubble')}
            >
              {activeBubble.kind === 'menu' ? (
                <div className="pet-ctx-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="pet-ctx-item"
                    onClick={() => {
                      setCtxMenuOpen(false);
                      focusPendingRef.current = true;
                      setComposerOpen((v) => !v);
                    }}
                  >
                    <span>{composerOpen ? t('收起输入条', 'Close prompt') : t('唤出输入条', 'Quick prompt')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="pet-ctx-item"
                    onClick={() => {
                      setCtxMenuOpen(false);
                      void petWindow('show-main').catch(report);
                    }}
                  >
                    <span>{t('打开主窗口', 'Open main window')}</span>
                    <ExternalLink size={12} aria-hidden="true" />
                  </button>
                  <div className="pet-ctx-sep" />
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={autoRead}
                    className="pet-ctx-item"
                    onClick={() => {
                      const next = !autoRead;
                      setAutoRead(next);
                      writeLocal(AUTO_READ_KEY, String(next));
                      if (!next) stopReading();
                      setCtxMenuOpen(false);
                    }}
                  >
                    <span>{t('自动朗读回复', 'Auto-read replies')}</span>
                    <span className="pet-ctx-val">{autoRead ? t('开', 'On') : t('关', 'Off')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={autoFade}
                    className="pet-ctx-item"
                    onClick={() => {
                      const next = !autoFade;
                      setAutoFade(next);
                      writeLocal(AUTO_FADE_KEY, String(next));
                      setCtxMenuOpen(false);
                    }}
                  >
                    <span>{t('回复 10 秒自动淡出', 'Auto-fade replies (10s)')}</span>
                    <span className="pet-ctx-val">{autoFade ? t('开', 'On') : t('关', 'Off')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={dndMode}
                    className="pet-ctx-item"
                    onClick={() => {
                      const next = !dndMode;
                      setDndMode(next);
                      writeLocal(DND_KEY, String(next));
                      setCtxMenuOpen(false);
                    }}
                  >
                    <span>{t('勿扰（暂停主动冒泡）', 'Quiet mode')}</span>
                    <span className="pet-ctx-val">{dndMode ? t('开', 'On') : t('关', 'Off')}</span>
                  </button>
                  <div className="pet-ctx-sep" />
                  <button
                    type="button"
                    role="menuitem"
                    className="pet-ctx-item"
                    onClick={() => {
                      setCtxMenuOpen(false);
                      cancelRecording();
                      stopReading();
                      focusPendingRef.current = true;
                      setSettingsOpen(true);
                    }}
                  >
                    <span>{t('语音设置…', 'Voice settings…')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="pet-ctx-item is-danger"
                    onClick={() => {
                      setCtxMenuOpen(false);
                      cancelRecording();
                      stopReading();
                      void petWindow('hide').catch(report);
                    }}
                  >
                    <span>{t('隐藏桌宠', 'Hide pet')}</span>
                  </button>
                </div>
              ) : activeBubble.kind === 'settings' ? (
                <div className="pet-bubble-settings">
                  <VoiceSettings onClose={() => setSettingsOpen(false)} />
                </div>
              ) : activeBubble.kind === 'voice' ? (
                <div className="pet-thought-row">
                  <span className="pet-thought-dots" aria-hidden="true">
                    <span /><span /><span />
                  </span>
                  <span className="pet-thought-text">{activeBubble.text}</span>
                </div>
              ) : activeBubble.kind === 'thought' ? (
                <div className="pet-thought-row">
                  <span className="pet-thought-dots" aria-hidden="true">
                    <span /><span /><span />
                  </span>
                  <span className="pet-thought-text">{activeBubble.text}</span>
                  {activeBubble.canStop ? (
                    <button
                      type="button"
                      className="pet-thought-stop"
                      title={t('停止 Bot 当前任务', 'Stop bot task')}
                      onClick={() => {
                        const state = snapshotRef.current;
                        if (state.deviceId && state.botId) {
                          void postAction({
                            id: crypto.randomUUID(),
                            kind: 'stop',
                            deviceId: state.deviceId,
                            botId: state.botId,
                          }).catch(report);
                        }
                      }}
                    >
                      <Square size={9} fill="currentColor" aria-hidden="true" />
                      <span>{t('停止', 'Stop')}</span>
                    </button>
                  ) : null}
                </div>
              ) : activeBubble.kind === 'question' ? (
                <ToolPresentationCard
                  key={`${activeBubble.presentation.requestId}:${activeBubble.presentation.status}`}
                  presentation={activeBubble.presentation}
                  active={activeBubble.interactive}
                  disabled={snapshot.connection !== 'ready'}
                  questionnaireInterrupted={activeBubble.interrupted}
                  variant="pet-bubble"
                  onSubmit={activeBubble.interactive ? submitQuestionnaire : undefined}
                  onDismissBubble={() => dismissBubble(activeBubble.id)}
                />
              ) : activeBubble.kind === 'handoff' ? (
                <div className="pet-handoff-wrap">
                  <div className="pet-handoff-head">
                    <span className={`pet-handoff-badge is-${activeBubble.tone}`}>
                      {activeBubble.tone === 'danger'
                        ? <AlertTriangle size={12} aria-hidden="true" />
                        : <ShieldAlert size={12} aria-hidden="true" />}
                      <span>{activeBubble.badge}</span>
                    </span>
                    <button
                      type="button"
                      className="pet-mini-icon"
                      title={t('收起', 'Dismiss')}
                      aria-label={t('收起', 'Dismiss')}
                      onClick={() => dismissBubble(activeBubble.id)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="pet-handoff-title">{activeBubble.title}</div>
                  <p className="pet-handoff-desc">{activeBubble.detail}</p>
                  <div className="pet-handoff-actions">
                    {activeBubble.showRefresh ? (
                      <button
                        type="button"
                        className="pet-handoff-ghost"
                        onClick={() => void postAction({ id: crypto.randomUUID(), kind: 'refresh' }).catch(report)}
                      >
                        <RefreshCw size={12} aria-hidden="true" />
                        <span>{t('刷新', 'Refresh')}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="pet-handoff-ghost"
                        onClick={() => dismissBubble(activeBubble.id)}
                      >
                        {t('稍后', 'Later')}
                      </button>
                    )}
                    {activeBubble.actionLabel ? (
                      <button
                        type="button"
                        className="pet-handoff-primary"
                        onClick={() => {
                          void petWindow('show-main').catch(report);
                          dismissBubble(activeBubble.id);
                        }}
                      >
                        <span>{activeBubble.actionLabel}</span>
                        <ExternalLink size={12} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : activeBubble.kind === 'progress' ? (
                <div className="pet-progress-wrap">
                  {snapshot.todo && snapshot.todo.tasks.length > 0 ? (
                    <>
                      <div className="pet-progress-head">
                        <span className="pet-progress-title">
                          <ListTodo size={14} aria-hidden="true" />
                          <span>{t('任务清单', 'Tasks')}</span>
                        </span>
                        <span className="pet-progress-count tabular-nums">
                          {snapshot.todo.tasks.filter((item) => item.status === 'completed').length}/{snapshot.todo.tasks.length}
                        </span>
                      </div>
                      <ul className="pet-todo-ul">
                        {snapshot.todo.tasks.slice(0, 6).map((item) => (
                          <li key={item.id} className={`pet-todo-li is-${item.status}`}>
                            <span className="pet-todo-bullet" aria-hidden="true">
                              {item.status === 'completed'
                                ? <CheckCircle2 size={14} />
                                : item.status === 'in_progress'
                                  ? <CircleDot size={14} />
                                  : <Circle size={14} />}
                            </span>
                            <span className="pet-todo-subject">{item.subject}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : snapshot.task ? (
                    <>
                      <div className="pet-progress-head">
                        <span className="pet-progress-title">
                          <ClipboardList size={14} aria-hidden="true" />
                          <span>{snapshot.task.title}</span>
                        </span>
                        <span className="pet-progress-count tabular-nums">
                          {snapshot.task.stepCount.total > 0
                            ? `${snapshot.task.stepCount.done}/${snapshot.task.stepCount.total}`
                            : snapshot.task.cardLabel}
                        </span>
                      </div>
                      {snapshot.task.summary ? (
                        <p className="pet-handoff-desc">{snapshot.task.summary}</p>
                      ) : null}
                    </>
                  ) : null}
                  <div className="pet-bubble-foot">
                    <span className="pet-bubble-meta">{snapshot.botName}</span>
                    <div className="pet-bubble-actions">
                      <button
                        type="button"
                        className="pet-mini-btn"
                        onClick={() => void petWindow('show-main').catch(report)}
                      >
                        <ExternalLink size={12} aria-hidden="true" />
                        <span>{t('主窗口', 'Main')}</span>
                      </button>
                      <button
                        type="button"
                        className="pet-mini-icon"
                        title={t('收起', 'Dismiss')}
                        aria-label={t('收起', 'Dismiss')}
                        onClick={() => dismissBubble(activeBubble.id)}
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              ) : activeBubble.kind === 'proactive-alert' ? (
                <div className="pet-proactive-wrap">
                  <div
                    className="pet-proactive-line"
                    title={`${activeBubble.alert.botName} · ${activeBubble.alert.summary}`}
                  >
                    <span className="pet-proactive-icon" aria-hidden="true">
                      <Bell size={13} />
                    </span>
                    <span className="pet-proactive-bot">{activeBubble.alert.botName}</span>
                    <span className="pet-proactive-sep" aria-hidden="true">·</span>
                    <span className="pet-proactive-summary">{activeBubble.alert.summary}</span>
                  </div>
                  <div className="pet-proactive-actions">
                    <button
                      type="button"
                      className="pet-handoff-ghost"
                      onClick={() => {
                        const alert = activeBubble.alert;
                        setRevealedProactiveId(null);
                        void postAction({
                          id: crypto.randomUUID(),
                          kind: 'dismiss-proactive-alert',
                          resultId: alert.resultId,
                        }).catch(report);
                      }}
                    >
                      {t('忽略', 'Dismiss')}
                    </button>
                    <button
                      type="button"
                      className="pet-handoff-primary"
                      onClick={() => {
                        const alert = activeBubble.alert;
                        setRevealedProactiveId(null);
                        void postAction({
                          id: crypto.randomUUID(),
                          kind: 'open-bot',
                          deviceId: alert.deviceId,
                          botId: alert.botId,
                        }).catch(report);
                        void petWindow('show-main').catch(report);
                      }}
                    >
                      <span>{t('查看', 'View')}</span>
                      <ExternalLink size={12} aria-hidden="true" />
                    </button>
                  </div>
                  {revealedProactiveId !== activeBubble.alert.resultId && !hoveringBubble && !bubbleFocused ? (
                    <div className="pet-autofade-bar" aria-hidden="true">
                      <div className="pet-autofade-fill is-proactive" />
                    </div>
                  ) : null}
                </div>
              ) : (
                /* Speech reply bubble */
                <div className="pet-speech-wrap">
                  {activeBubble.promptQuote ? (
                    <div className="pet-speech-quote" title={activeBubble.promptQuote}>
                      <span>{t('你：', 'You: ')}{activeBubble.promptQuote}</span>
                    </div>
                  ) : null}
                  <div className={`pet-speech-body${activeBubble.streaming ? ' pet-streaming' : ''}`}>
                    <PetMarkdown text={activeBubble.text} onCopyLink={copyMarkdownLink} />
                  </div>
                  <div className="pet-bubble-foot">
                    <span className="pet-bubble-meta">
                      {activeBubble.streaming ? t('正在回复…', 'Replying…') : snapshot.botName}
                    </span>
                    <div className="pet-bubble-actions">
                      {!activeBubble.streaming && activeBubble.messageId ? (
                        <button
                          type="button"
                          className={`pet-mini-btn${speaking && speakingMessageId === activeBubble.messageId ? ' is-active' : ''}`}
                          title={speaking && speakingMessageId === activeBubble.messageId ? t('停止朗读', 'Stop reading') : t('朗读', 'Read aloud')}
                          onClick={() => {
                            if (speaking && speakingMessageId === activeBubble.messageId) stopReading();
                            else speakMessage(activeBubble.messageId!, activeBubble.text);
                          }}
                        >
                          {speaking && speakingMessageId === activeBubble.messageId
                            ? <VolumeX size={12} aria-hidden="true" />
                            : <Volume2 size={12} aria-hidden="true" />}
                          <span>{speaking && speakingMessageId === activeBubble.messageId ? t('停读', 'Mute') : t('朗读', 'Read')}</span>
                        </button>
                      ) : null}
                      {activeBubble.streaming && snapshot.canStop ? (
                        <button
                          type="button"
                          className="pet-thought-stop"
                          onClick={() => {
                            const state = snapshotRef.current;
                            if (state.deviceId && state.botId) {
                              void postAction({
                                id: crypto.randomUUID(),
                                kind: 'stop',
                                deviceId: state.deviceId,
                                botId: state.botId,
                              }).catch(report);
                            }
                          }}
                        >
                          <Square size={9} fill="currentColor" aria-hidden="true" />
                          <span>{t('停止', 'Stop')}</span>
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="pet-mini-btn"
                        title={t('在主窗口继续', 'Continue in main window')}
                        onClick={() => void petWindow('show-main').catch(report)}
                      >
                        <ExternalLink size={12} aria-hidden="true" />
                        <span>{t('主窗口', 'Main')}</span>
                      </button>
                      <button
                        type="button"
                        className="pet-mini-icon"
                        title={t('收起气泡', 'Dismiss bubble')}
                        aria-label={t('收起气泡', 'Dismiss bubble')}
                        onClick={() => dismissBubble(activeBubble.id)}
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  {autoFade && !activeBubble.streaming && !hoveringBubble && !speaking ? (
                    <div className="pet-autofade-bar" aria-hidden="true">
                      <div className="pet-autofade-fill" />
                    </div>
                  ) : null}
                </div>
              )}

              <span className="pet-bubble-tail" aria-hidden="true" />
            </section>
          </div>
        ) : null}

        {/* 2. DOCK ROW: FLOATING QUICK COMPOSER PILL + MASCOT ACTOR */}
        <div className="pet-dock-row">
          {composerOpen && !settingsOpen ? (
            <div className="pet-composer-area">
              <form
                className="pet-composer-pill"
                data-pet-hit="true"
                data-pet-hit-pad="12"
                data-pet-hit-radius="24"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSend) void sendText(draft);
                }}
              >
                <textarea
                  ref={composerRef}
                  rows={1}
                  className="pet-composer-input"
                  value={draft}
                  aria-label={t('发送给本机主助手的消息', 'Message to the local main bot')}
                  placeholder={snapshot.connection === 'ready'
                    ? t(`和 ${snapshot.botName} 说点什么…`, `Ask ${snapshot.botName}…`)
                    : t('本机主助手未连接…', 'Local main bot offline…')}
                  disabled={!snapshot.botId}
                  onChange={(event) => changeDraft(event.target.value)}
                  onCompositionStart={() => { composingRef.current = true; }}
                  onCompositionEnd={() => { composingRef.current = false; }}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !composingRef.current &&
                      !event.nativeEvent.isComposing &&
                      event.nativeEvent.keyCode !== 229
                    ) {
                      event.preventDefault();
                      if (canSend) void sendText(draft);
                    }
                  }}
                />
                <button
                  type="button"
                  className={`pet-pill-mic${recording ? ' is-listening' : ''}`}
                  disabled={!canSend && !recording}
                  title={t('按住说话，松开发送；Esc 取消', 'Hold to speak, release to send; Esc cancels')}
                  aria-label={t('按住说话，松开发送', 'Hold to speak, release to send')}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    beginRecording();
                  }}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                    void finishRecording();
                  }}
                  onPointerCancel={cancelRecording}
                  onBlur={() => { if (recordingRef.current && !recordingRef.current.released) cancelRecording(); }}
                >
                  <Mic size={15} aria-hidden="true" />
                </button>
                {snapshot.canStop && !draft.trim() ? (
                  <button
                    type="button"
                    className="pet-pill-stop"
                    title={t('停止当前任务', 'Stop task')}
                    aria-label={t('停止当前任务', 'Stop task')}
                    onClick={() => {
                      const state = snapshotRef.current;
                      if (state.deviceId && state.botId) {
                        void postAction({
                          id: crypto.randomUUID(),
                          kind: 'stop',
                          deviceId: state.deviceId,
                          botId: state.botId,
                        }).catch(report);
                      }
                    }}
                  >
                    <Square size={11} fill="currentColor" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="pet-pill-send"
                    disabled={!canSend || !draft.trim()}
                    title={t('发送', 'Send')}
                    aria-label={t('发送', 'Send')}
                  >
                    <ArrowUp size={16} aria-hidden="true" />
                  </button>
                )}
              </form>
              {canRecallReply ? (
                <div className="pet-composer-sub" data-pet-hit="true" data-pet-hit-pad="4" data-pet-hit-radius="12">
                  <button
                    type="button"
                    className="pet-recall-chip"
                    onClick={() => {
                      if (!latestReply) return;
                      const rid = `speech:${latestReply.message.id}`;
                      setDismissedIds((prev) => {
                        const next = new Set(prev);
                        next.delete(rid);
                        return next;
                      });
                      setForcedReplyId(rid);
                    }}
                  >
                    <History size={11} aria-hidden="true" />
                    <span>{t('查看上一条回复', 'Last reply')}</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div
            className={`pet-dock${composerOpen ? ' is-composer-open' : ''}`}
            data-mood={petMood}
            onPointerEnter={() => setHoveringDock(true)}
            onPointerLeave={() => setHoveringDock(false)}
          >
            {/* Hover micro action rail (hidden when idle; zero permanent clutter) */}
            {!composerOpen ? (
              <div
                className={`pet-hover-rail${hoveringDock ? ' is-shown' : ''}`}
                data-pet-hit={hoveringDock ? 'true' : undefined}
                data-pet-hit-pad="6"
                data-pet-hit-radius="16"
                aria-label={t('桌宠快捷操作', 'Quick pet actions')}
              >
                <button
                  type="button"
                  className={`pet-rail-btn${recording ? ' is-recording' : ''}`}
                  disabled={!canSend && !recording}
                  title={t('按住直接说话', 'Hold to talk')}
                  aria-label={t('按住直接说话', 'Hold to talk')}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    beginRecording();
                  }}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                    void finishRecording();
                  }}
                  onPointerCancel={cancelRecording}
                >
                  <Mic size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="pet-rail-btn"
                  title={t('打开主窗口', 'Open main window')}
                  aria-label={t('打开主窗口', 'Open main window')}
                  onClick={() => void petWindow('show-main').catch(report)}
                >
                  <ExternalLink size={12.5} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="pet-rail-btn"
                  title={t('语音设置', 'Voice settings')}
                  aria-label={t('语音设置', 'Voice settings')}
                  onClick={() => {
                    cancelRecording();
                    stopReading();
                    focusPendingRef.current = true;
                    setSettingsOpen((v) => !v);
                  }}
                >
                  <Settings2 size={12.5} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="pet-rail-btn"
                  title={t('隐藏桌宠', 'Hide pet')}
                  aria-label={t('隐藏桌宠', 'Hide pet')}
                  onClick={() => {
                    cancelRecording();
                    stopReading();
                    void petWindow('hide').catch(report);
                  }}
                >
                  <X size={12.5} aria-hidden="true" />
                </button>
              </div>
            ) : null}

            {/* Mascot Avatar Button */}
            <button
              type="button"
              className="pet-avatar"
              data-pet-hit="true"
              data-pet-hit-pad="10"
              data-pet-hit-radius="26"
              aria-expanded={composerOpen}
              aria-label={t('单击对话，拖动移动，右键菜单', 'Click to chat, drag to move, right-click for menu') + ' · ' + snapshot.botName}
              onContextMenu={(event) => {
                event.preventDefault();
                focusPendingRef.current = true;
                setCtxMenuOpen((open) => !open);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                setCtxMenuOpen(false);
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
                if (event.detail > 0 && !avatarPressValidRef.current) return;
                avatarPressValidRef.current = false;
                if (settingsOpen) {
                  setSettingsOpen(false);
                  return;
                }
                const pendingAlert = snapshotRef.current.proactiveAlert;
                const alertHidden = Boolean(
                  pendingAlert &&
                  (dndMode || tuckedProactiveIds.has(pendingAlert.resultId)) &&
                  revealedProactiveId !== pendingAlert.resultId,
                );
                if (alertHidden && pendingAlert && (!activeBubble || activeBubble.kind === 'progress')) {
                  setTuckedProactiveIds((prev) => {
                    if (!prev.has(pendingAlert.resultId)) return prev;
                    const next = new Set(prev);
                    next.delete(pendingAlert.resultId);
                    return next;
                  });
                  setRevealedProactiveId(pendingAlert.resultId);
                  focusPendingRef.current = true;
                  return;
                }
                const next = !composerOpen;
                if (next) {
                  focusPendingRef.current = true;
                  if (snapshotRef.current.connection !== 'ready') {
                    setDismissedIds((prev) => {
                      const cleaned = new Set<string>();
                      prev.forEach((item) => { if (!item.startsWith('err:')) cleaned.add(item); });
                      return cleaned;
                    });
                  }
                  void postAction({ id: crypto.randomUUID(), kind: 'refresh' }).catch(() => {});
                } else {
                  cancelRecording();
                }
                setComposerOpen(next);
              }}
            >
              <GrokBotAnimatedMark
                seedId={targetKey(snapshot) || 'desktop-pet'}
                shape={avatar.shape}
                color={avatar.color}
                state={mascotState}
                size={88}
                maxFrameRate={busy || recording || transcribing || speaking ? 30 : 18}
                isPlaying={pageVisible}
                isStatic={false}
              />
              {showDotBadge ? <span className={`pet-badge-dot is-${dotTone}`} aria-hidden="true" /> : null}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
