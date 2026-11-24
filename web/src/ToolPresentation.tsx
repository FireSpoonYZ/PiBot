import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  CircleDot,
  ClipboardList,
  ListTodo,
  MessageSquarePlus,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type {
  ToolPresentation as HostToolPresentation,
  TodoPresentation,
  QuestionnairePresentation,
  QuestionnaireAnswerPresentation,
  VaultUnlockPresentation,
} from '../../host-core/index.js';
import { ActionSlip, InlineBanner, type ActionSlipTone } from './components/ui';
import type { TaskStatus, TaskStepStatus } from './tasks/types';
import {
  GoogleAccountSelectCard,
  GoogleBrowserTakeoverCard,
  GoogleReadinessCard,
  GoogleSetupChatCard,
} from './google/GoogleChatCards';
import { readGoogleSetupPresentation } from './google/currentGoogleSetup';
import type {
  GoogleAccountSelectPresentation,
  GoogleBrowserTakeoverPresentation,
  GoogleChatCardContext,
  GoogleReadinessPresentation,
  GoogleSetupPresentation,
  GoogleToolPresentation,
} from './google/types';
import { useText } from './ui';
import { VaultUnlockCard } from './vault/VaultUnlockCard';
import './tool-presentation.css';

/**
 * 工具交互呈现：消费 host LiveTool/LiveMessage 上有界白名单投影的 presentation。
 * live 帧已由 remote-live-protocol 严格校验；raw 历史直接读取 entry.model 的
 * toolResult.details.presentation 原文。这里按契约做最终把关：kind+version 严格
 * 匹配、字段类型核验、未知字段与畸形值整体拒绝——不 trim/filter/重排，
 * 选项索引与原文必须与服务端保存的问卷一一对应。
 * 类型 type-only 引用 host-core 契约，不维护重复接口。
 */

export interface TaskStepPreviewPresentation {
  id: string;
  text: string;
  status: TaskStepStatus;
  botName?: string;
}

export interface TaskPendingPromptPresentation {
  kind: 'plan' | 'question';
  botId: string;
  text: string;
  options?: string[];
}

export interface TaskPresentation {
  kind: 'task';
  version: 1;
  installationId: string;
  taskId: string;
  title: string;
  status: TaskStatus;
  cardLabel: string;
  summary?: string;
  stepCount: { done: number; total: number };
  pendingPrompt?: TaskPendingPromptPresentation | null;
  stepsPreview?: TaskStepPreviewPresentation[];
}

export type ToolPresentation = HostToolPresentation | TaskPresentation | GoogleToolPresentation;

export type {
  TodoPresentation,
  QuestionnairePresentation,
  VaultUnlockPresentation,
  GoogleChatCardContext,
  GoogleToolPresentation,
  GoogleSetupPresentation,
  GoogleAccountSelectPresentation,
  GoogleBrowserTakeoverPresentation,
  GoogleReadinessPresentation,
};

/** Private vaultControl response only; never submit through questionnaire or chat actions. */
export type VaultUnlockSubmitPayload =
  | { requestId: string; masterPassword: string; cancelled?: false }
  | { requestId: string; cancelled: true };

/** 提交参数签名：宿主侧固定 callCapabilityAction 的 request 部分；deviceId/botId 由父级补。
 * 用对象 type alias（非 interface）声明，保持对 ActionRequest.input 的 JsonValue 可赋值。 */
export type QuestionnaireSubmitPayload = {
  conversationId: number;
  requestId: string;
  cancelled: boolean;
  answers: QuestionnaireSubmitAnswer[];
  globalNote?: string;
};

export type QuestionnaireSubmitAnswer = {
  questionIndex: number;
  selectedOptions?: number[];
  customText?: string;
  notes?: string;
};

const CUSTOM_TEXT_LIMIT = 2000;
const GLOBAL_NOTE_LIMIT = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isOptString = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string';
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);

/** 严格核验一条 todo 任务；任一字段不合规即整条记录拒绝（调用方整体 null）。 */
function checkTodoTask(task: unknown): boolean {
  if (!isRecord(task)) return false;
  if (!isInt(task.id) || (task.id as number) < 0) return false;
  if (!isNonEmptyString(task.subject)) return false;
  return task.status === 'pending' || task.status === 'in_progress' || task.status === 'completed';
}

function checkOption(option: unknown): boolean {
  if (!isRecord(option)) return false;
  if (!isNonEmptyString(option.label)) return false;
  if (!isNonEmptyString(option.description)) return false;
  return isOptString(option.preview);
}

function checkQuestion(question: unknown): boolean {
  if (!isRecord(question)) return false;
  if (!isNonEmptyString(question.question)) return false;
  if (!isNonEmptyString(question.header)) return false;
  if (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') return false;
  if (!Array.isArray(question.options) || question.options.length < 1) return false;
  return question.options.every(checkOption);
}

function checkAnswer(answer: unknown): boolean {
  if (!isRecord(answer)) return false;
  if (!isInt(answer.questionIndex) || (answer.questionIndex as number) < 0) return false;
  if (!isNonEmptyString(answer.question)) return false;
  if (answer.kind !== 'option' && answer.kind !== 'custom' && answer.kind !== 'multi') return false;
  if (!(typeof answer.answer === 'string' || answer.answer === null)) return false;
  if (answer.selected !== undefined && !(Array.isArray(answer.selected) && answer.selected.every(isNonEmptyString))) return false;
  if (!isOptString(answer.notes) || !isOptString(answer.preview)) return false;
  return true;
}

function checkResult(result: unknown): boolean {
  if (!isRecord(result)) return false;
  if (!Array.isArray(result.answers) || !result.answers.every(checkAnswer)) return false;
  if (typeof result.cancelled !== 'boolean') return false;
  if (!isOptString(result.globalNote)) return false;
  if (result.unanswered !== undefined && !(Array.isArray(result.unanswered) && result.unanswered.every((i) => isInt(i) && i >= 0))) return false;
  return true;
}

const TASK_STATUSES = new Set(['triaging', 'working', 'waiting', 'done', 'cancelled']);
const TASK_STEP_STATUSES = new Set(['unassigned', 'todo', 'working', 'waiting', 'blocked', 'done', 'cancelled']);

function checkTaskPendingPrompt(prompt: unknown): boolean {
  if (prompt === undefined || prompt === null) return true;
  if (!isRecord(prompt)) return false;
  if (prompt.kind !== 'plan' && prompt.kind !== 'question') return false;
  if (!isNonEmptyString(prompt.botId) || !isNonEmptyString(prompt.text)) return false;
  if (prompt.options !== undefined && !(Array.isArray(prompt.options) && prompt.options.every(isNonEmptyString))) return false;
  return true;
}

function checkTaskStepPreview(step: unknown): boolean {
  if (!isRecord(step)) return false;
  if (!isNonEmptyString(step.id) || !isNonEmptyString(step.text)) return false;
  if (typeof step.status !== 'string' || !TASK_STEP_STATUSES.has(step.status)) return false;
  return isOptString(step.botName);
}

/**
 * 从 live slot / 历史消息上识别 presentation；严格 kind+version 白名单核验，
 * 任何不合规结构整体返回 null——不裁剪、不填默认值，选项保持原文原序。
 * wire（live）值已过 normalizeToolPresentation，raw 历史值按同一契约把关。
 */
export function readToolPresentation(value: unknown): ToolPresentation | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (value.kind === 'todo') {
    if (!isNonEmptyString(value.installationId)) return null;
    if (!Array.isArray(value.tasks) || !value.tasks.every(checkTodoTask)) return null;
    return value as unknown as TodoPresentation;
  }
  if (value.kind === 'task') {
    if (!isNonEmptyString(value.installationId)) return null;
    if (!isNonEmptyString(value.taskId) || !isNonEmptyString(value.title) || !isNonEmptyString(value.cardLabel)) return null;
    if (typeof value.status !== 'string' || !TASK_STATUSES.has(value.status)) return null;
    if (!isOptString(value.summary)) return null;
    if (!isRecord(value.stepCount) || !isInt(value.stepCount.done) || value.stepCount.done < 0 || !isInt(value.stepCount.total) || value.stepCount.total < 0) return null;
    if (!checkTaskPendingPrompt(value.pendingPrompt)) return null;
    if (value.stepsPreview !== undefined && !(Array.isArray(value.stepsPreview) && value.stepsPreview.every(checkTaskStepPreview))) return null;
    return value as unknown as TaskPresentation;
  }
  if (value.kind === 'questionnaire') {
    if (!isNonEmptyString(value.installationId)) return null;
    if (!isNonEmptyString(value.requestId)) return null;
    if (value.status !== 'pending' && value.status !== 'answered' && value.status !== 'cancelled') return null;
    if (!isInt(value.conversationId)) return null;
    if (!Array.isArray(value.questions) || value.questions.length < 1 || !value.questions.every(checkQuestion)) return null;
    if (value.result !== undefined && !checkResult(value.result)) return null;
    return value as unknown as QuestionnairePresentation;
  }
  if (value.kind === 'vault-unlock') {
    if (!isNonEmptyString(value.installationId)) return null;
    if (Object.keys(value).some(key => !['kind', 'version', 'installationId', 'conversationId', 'requestId', 'mode', 'status', 'source', 'serverUrl'].includes(key))) return null;
    if (!isNonEmptyString(value.requestId) || !isInt(value.conversationId) || value.conversationId < 0) return null;
    if (value.mode !== 'initialize' && value.mode !== 'unlock') return null;
    if (value.status !== 'pending' && value.status !== 'unlocked' && value.status !== 'cancelled' && value.status !== 'interrupted') return null;
    if (value.source !== undefined && value.source !== 'local' && value.source !== 'vaultwarden') return null;
    if (value.serverUrl !== undefined && !isNonEmptyString(value.serverUrl)) return null;
    return value as unknown as VaultUnlockPresentation;
  }
  if (value.kind === 'google-setup') {
    return readGoogleSetupPresentation(value);
  }
  if (value.kind === 'google-account-select') {
    if (!isOptString(value.installationId)) return null;
    if (!isOptString(value.requestId) || !isOptString(value.botId) || !isOptString(value.actionLabel)) return null;
    if (!isOptString(value.toolName) || !isOptString(value.service) || !isOptString(value.reason) || !isOptString(value.selectedEmail)) return null;
    if (value.conversationId !== undefined && !isInt(value.conversationId)) return null;
    if (value.status !== undefined && value.status !== 'pending' && value.status !== 'selected' && value.status !== 'cancelled') return null;
    if (value.accounts !== undefined) {
      if (!Array.isArray(value.accounts)) return null;
      const valid = value.accounts.every(item =>
        isRecord(item) &&
        isNonEmptyString(item.email) &&
        isOptString(item.id) &&
        (item.status === undefined || item.status === 'connected' || item.status === 'reconnect'),
      );
      if (!valid) return null;
    }
    return value as unknown as GoogleAccountSelectPresentation;
  }
  if (value.kind === 'google-browser-takeover') {
    if (!isOptString(value.installationId)) return null;
    if (!isOptString(value.botId) || !isOptString(value.pageId) || !isOptString(value.phase)) return null;
    if (!isOptString(value.reason) || !isOptString(value.url) || !isOptString(value.step)) return null;
    if (value.canStreamInteract !== undefined && typeof value.canStreamInteract !== 'boolean') return null;
    return value as unknown as GoogleBrowserTakeoverPresentation;
  }
  if (value.kind === 'google-readiness') {
    if (!isOptString(value.installationId)) return null;
    if (!isOptString(value.account) || !isOptString(value.service) || !isOptString(value.detail) || !isOptString(value.enableUrl)) return null;
    if (value.state !== undefined && !['ready', 'needs-permission', 'api-disabled', 'blocked-by-admin', 'error', 'unconfigured', 'disconnected', 'reconnect', 'ambiguous-account'].includes(String(value.state))) return null;
    if (value.accounts !== undefined && !(Array.isArray(value.accounts) && value.accounts.every(isNonEmptyString))) return null;
    return value as unknown as GoogleReadinessPresentation;
  }
  return null;
}

export interface ToolPresentationCardProps {
  presentation: ToolPresentation;
  /** 仅当前活跃工具的 pending 交互可提交；历史卡片一律只读。 */
  active: boolean;
  disabled?: boolean;
  questionnaireInterrupted?: boolean;
  variant?: 'desktop' | 'pet-bubble';
  requesterName?: string;
  googleContext?: GoogleChatCardContext;
  onSubmit?: (input: QuestionnaireSubmitPayload) => Promise<unknown>;
  onSubmitVaultUnlock?: (input: VaultUnlockSubmitPayload) => Promise<unknown>;
  onOpenTask?: (taskId: string, openEdit?: boolean) => void;
  onConfirmTaskPlan?: (taskId: string) => Promise<void> | void;
  onAnswerTaskPrompt?: (taskId: string, answer: string) => Promise<void> | void;
  onDismissBubble?: () => void;
}

export function ToolPresentationCard({
  presentation,
  active,
  disabled = false,
  questionnaireInterrupted = false,
  variant,
  requesterName,
  googleContext,
  onSubmit,
  onSubmitVaultUnlock,
  onOpenTask,
  onConfirmTaskPlan: _onConfirmTaskPlan,
  onAnswerTaskPrompt: _onAnswerTaskPrompt,
  onDismissBubble,
}: ToolPresentationCardProps) {
  const t = useText();
  if (presentation.kind === 'todo') {
    return <TodoCard presentation={presentation} t={t} />;
  }
  if (presentation.kind === 'task') {
    return <TaskCard presentation={presentation} onOpenTask={onOpenTask} t={t} />;
  }
  if (presentation.kind === 'vault-unlock') {
    return <VaultUnlockCard presentation={presentation} active={active} disabled={disabled} requesterName={requesterName} onSubmit={onSubmitVaultUnlock} />;
  }
  if (presentation.kind === 'google-setup') {
    return <GoogleSetupChatCard presentation={presentation} />;
  }
  if (presentation.kind === 'google-account-select') {
    return <GoogleAccountSelectCard presentation={presentation} active={active} disabled={disabled} googleContext={googleContext} />;
  }
  if (presentation.kind === 'google-browser-takeover') {
    return <GoogleBrowserTakeoverCard presentation={presentation} active={active} disabled={disabled} googleContext={googleContext} />;
  }
  if (presentation.kind === 'google-readiness') {
    return <GoogleReadinessCard presentation={presentation} active={active} disabled={disabled} googleContext={googleContext} />;
  }
  return (
    <QuestionnaireCard
      key={presentation.requestId}
      presentation={presentation}
      active={active && presentation.status === 'pending' && Boolean(onSubmit)}
      disabled={disabled}
      interrupted={questionnaireInterrupted && presentation.status === 'pending'}
      embeddedBubble={variant === 'pet-bubble'}
      onSubmit={onSubmit}
      onDismissBubble={onDismissBubble}
      t={t}
    />
  );
}

function taskTone(status: TaskStatus): ActionSlipTone {
  switch (status) {
    case 'done':
      return 'live';
    case 'waiting':
      return 'attention';
    case 'working':
      return 'info';
    default:
      return 'neutral';
  }
}

function TaskCard({
  presentation,
  onOpenTask,
  t,
}: {
  presentation: TaskPresentation;
  onOpenTask?: (taskId: string, openEdit?: boolean) => void;
  t: (zh: string, en: string) => string;
}) {
  const hasSteps = presentation.stepCount.total > 0;
  return (
    <ActionSlip
      className="tp-slip tp-task"
      tone={taskTone(presentation.status)}
      compact
      role="group"
      ariaLabel={presentation.title}
      icon={<ClipboardList size={16} aria-hidden="true" />}
      title={presentation.title}
      status={<span role="status">{presentation.cardLabel}</span>}
      meta={
        hasSteps ? (
          <span className="tabular-nums">
            {t(`已完成 ${presentation.stepCount.done}/${presentation.stepCount.total}`, `${presentation.stepCount.done}/${presentation.stepCount.total} done`)}
          </span>
        ) : undefined
      }
      headerExtra={
        onOpenTask ? (
          <button
            type="button"
            className="tp-btn tp-task-open-btn"
            onClick={() => onOpenTask(presentation.taskId)}
          >
            <span>{t('查看任务', 'View task')}</span>
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        ) : undefined
      }
    />
  );
}

function TodoCard({ presentation, t }: { presentation: TodoPresentation; t: (zh: string, en: string) => string }) {
  const done = presentation.tasks.filter(task => task.status === 'completed').length;
  const total = presentation.tasks.length;
  const allDone = total > 0 && done === total;
  return (
    <ActionSlip
      className="tp-slip tp-todo"
      tone={allDone ? 'live' : 'neutral'}
      compact
      role="group"
      ariaLabel={t('任务列表', 'Task list')}
      icon={<ListTodo size={16} aria-hidden="true" />}
      title={t('任务列表', 'Tasks')}
      status={
        <span className="tabular-nums" role="status">
          {done}/{total}
        </span>
      }
    >
      <ul className="tp-todo-list">
        {presentation.tasks.map(task => (
          <li key={task.id} className={`tp-todo-item is-${task.status}`}>
            <span className="tp-todo-icon" aria-hidden="true">
              {task.status === 'completed' ? (
                <CheckCircle2 size={15} aria-hidden="true" />
              ) : task.status === 'in_progress' ? (
                <CircleDot size={15} aria-hidden="true" />
              ) : (
                <Circle size={15} aria-hidden="true" />
              )}
            </span>
            <span className="tp-todo-subject">{task.subject}</span>
          </li>
        ))}
        {total === 0 ? (
          <li className="tp-todo-empty">{t('暂无任务', 'No tasks')}</li>
        ) : null}
      </ul>
    </ActionSlip>
  );
}

/** preview 按 Markdown 渲染：skipHtml + 不加载图片，与上游 preview 语义一致。 */
function OptionPreview({ preview }: { preview: string }) {
  return (
    <div className="tp-preview markdown">
      <ReactMarkdown skipHtml components={{ img: () => null }}>{preview}</ReactMarkdown>
    </div>
  );
}

function QuestionnaireCard({
  presentation,
  active,
  disabled,
  interrupted,
  embeddedBubble,
  onSubmit,
  onDismissBubble,
  t,
}: {
  presentation: QuestionnairePresentation;
  active: boolean;
  disabled: boolean;
  interrupted: boolean;
  embeddedBubble: boolean;
  onSubmit?: (input: QuestionnaireSubmitPayload) => Promise<unknown>;
  onDismissBubble?: () => void;
  t: (zh: string, en: string) => string;
}) {
  const errorId = useId();
  const editable = active && !disabled && !interrupted;
  const [localStatus, setLocalStatus] = useState<'settled' | null>(null);
  const [step, setStep] = useState(0);
  const [selectedMap, setSelectedMap] = useState<Record<number, number[]>>({});
  const [customOpenMap, setCustomOpenMap] = useState<Record<number, boolean>>({});
  const [customTextMap, setCustomTextMap] = useState<Record<number, string>>({});
  const [noteOpen, setNoteOpen] = useState(false);
  const [globalNote, setGlobalNote] = useState('');
  const [error, setError] = useState('');
  const [showValidation, setShowValidation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** 成功提交后保持锁定直到 live/历史终态卡片替换，防双击重复提交。 */
  const [submitted, setSubmitted] = useState(false);
  /** 同一 tick 内防重入：state 更新晚于同步 onChange 链。 */
  const submittingRef = useRef(false);
  const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const customInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const noteInputRef = useRef<HTMLInputElement | null>(null);
  const busy = submitting || submitted;

  const totalQuestions = presentation.questions.length;
  const clampedStep = Math.min(Math.max(0, step), Math.max(0, totalQuestions - 1));
  const useStepper = totalQuestions > 1;

  const cancelAutoAdvance = () => {
    if (autoAdvanceTimerRef.current !== null) {
      clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
  };

  useEffect(() => cancelAutoAdvance, []);

  const selectedFor = (index: number): number[] => selectedMap[index] ?? [];
  const isQuestionAnswered = (index: number): boolean =>
    selectedFor(index).length > 0 || Boolean((customTextMap[index] ?? '').trim());

  const clearError = () => {
    if (error) setError('');
  };

  const goToStep = (nextIndex: number) => {
    cancelAutoAdvance();
    setStep(Math.min(Math.max(0, nextIndex), Math.max(0, totalQuestions - 1)));
  };

  const toggleOption = (questionIndex: number, optionIndex: number, multi: boolean) => {
    cancelAutoAdvance();
    setSelectedMap(prev => {
      const current = prev[questionIndex] ?? [];
      const next = multi
        ? current.includes(optionIndex)
          ? current.filter(i => i !== optionIndex)
          : [...current, optionIndex]
        : [optionIndex];
      return { ...prev, [questionIndex]: next };
    });
    // 单选下 custom 与选项互斥：点选项即清掉已输入的自定义文本并收起输入行。
    if (!multi) {
      setCustomTextMap(prev => (prev[questionIndex] ? { ...prev, [questionIndex]: '' } : prev));
      setCustomOpenMap(prev => (prev[questionIndex] ? { ...prev, [questionIndex]: false } : prev));
    }
    clearError();

    // 步进模式下：单选且无 preview 且下一题尚未作答时，轻柔前进到下一题；
    // 用户点击「上一题」修改旧选项时不会被打断抢跳。
    const chosenOption = presentation.questions[questionIndex]?.options[optionIndex];
    if (
      useStepper &&
      !multi &&
      !chosenOption?.preview &&
      questionIndex < totalQuestions - 1 &&
      !isQuestionAnswered(questionIndex + 1)
    ) {
      autoAdvanceTimerRef.current = setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        setStep(current => (current === questionIndex ? questionIndex + 1 : current));
      }, 220);
    }
  };

  const toggleCustomRow = (questionIndex: number, multi: boolean) => {
    cancelAutoAdvance();
    const currentlyOpen = Boolean(customOpenMap[questionIndex] || (customTextMap[questionIndex] ?? '').trim());
    const nextOpen = !currentlyOpen;
    setCustomOpenMap(prev => ({ ...prev, [questionIndex]: nextOpen }));
    if (nextOpen && !multi) {
      setSelectedMap(prev => ((prev[questionIndex] ?? []).length > 0 ? { ...prev, [questionIndex]: [] } : prev));
    }
    if (!nextOpen) {
      setCustomTextMap(prev => (prev[questionIndex] ? { ...prev, [questionIndex]: '' } : prev));
    }
    clearError();
    if (nextOpen) {
      requestAnimationFrame(() => customInputRefs.current[questionIndex]?.focus());
    }
  };

  const changeCustomText = (questionIndex: number, multi: boolean, text: string) => {
    cancelAutoAdvance();
    setCustomTextMap(prev => ({ ...prev, [questionIndex]: text }));
    // 单选下输入 custom 即清空已选选项；multi 允许 selected + custom 并存。
    if (!multi && text !== '') {
      setSelectedMap(prev => ((prev[questionIndex] ?? []).length > 0 ? { ...prev, [questionIndex]: [] } : prev));
    }
    clearError();
  };

  const buildAnswers = () =>
    presentation.questions
      .map((_question, index) => {
        const selected = selectedFor(index);
        const customText = (customTextMap[index] ?? '').trim();
        if (selected.length === 0 && !customText) return null;
        const next: QuestionnaireSubmitPayload['answers'][number] = { questionIndex: index };
        if (selected.length > 0) next.selectedOptions = selected;
        if (customText) next.customText = customText;
        return next;
      })
      .filter((a): a is QuestionnaireSubmitPayload['answers'][number] => a !== null);

  const handleSubmit = async (cancelled: boolean) => {
    cancelAutoAdvance();
    if (!editable || !onSubmit || submittingRef.current || submitted) return;
    if (!cancelled) {
      const firstUnanswered = presentation.questions.findIndex((_q, idx) => !isQuestionAnswered(idx));
      const unansweredCount = presentation.questions.filter((_q, idx) => !isQuestionAnswered(idx)).length;
      if (unansweredCount > 0) {
        setShowValidation(true);
        if (useStepper && firstUnanswered >= 0) setStep(firstUnanswered);
        setError(t(`还有 ${unansweredCount} 道题未回答，请选择选项或填写自定义回答后再提交。`, `${unansweredCount} question(s) unanswered. Select an option or enter a custom answer before submitting.`));
        return;
      }
    }
    submittingRef.current = true;
    const payload: QuestionnaireSubmitPayload = cancelled
      ? { conversationId: presentation.conversationId, requestId: presentation.requestId, cancelled: true, answers: [] }
      : {
          conversationId: presentation.conversationId,
          requestId: presentation.requestId,
          cancelled: false,
          answers: buildAnswers(),
          globalNote: globalNote.trim() || undefined,
        };
    setSubmitting(true);
    setError('');
    setShowValidation(false);
    try {
      const result = await onSubmit(payload);
      // 并发先到者已结算：服务端返回 settled 时本地同步终态，不当作错误。
      if (result && typeof result === 'object' && (result as { status?: unknown }).status === 'settled') {
        setLocalStatus('settled');
      }
      setSubmitted(true);
    } catch (failure) {
      // 错误保留草稿，允许重试。
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const settledLocally = localStatus === 'settled' && presentation.status === 'pending';
  const displayStatus = interrupted ? 'cancelled' : presentation.status;
  const isPendingView = presentation.status === 'pending' && !interrupted && !settledLocally;
  const answeredCount = presentation.questions.filter((_q, idx) => isQuestionAnswered(idx)).length;
  const isLastStep = !useStepper || clampedStep === totalQuestions - 1;
  const inputDisabled = !editable || busy || settledLocally;

  const renderQuestion = (index: number) => {
    const question = presentation.questions[index];
    if (!question) return null;
    const selected = selectedFor(index);
    const groupName = `tp-q-${presentation.requestId}-${index}`;
    const multi = question.multiSelect === true;
    const customText = customTextMap[index] ?? '';
    const customActive = Boolean(customOpenMap[index] || customText.trim());
    const unanswered = !isQuestionAnswered(index);
    const invalid = showValidation && unanswered;
    const questionScope = question.header || question.question || `#${index + 1}`;

    return (
      <fieldset
        key={index}
        className={`qa-section${invalid ? ' is-unanswered' : ''}`}
        disabled={inputDisabled}
        data-unanswered={unanswered ? '' : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid && error ? errorId : undefined}
      >
        {(!useStepper || multi || !editable) ? (
          <div className="qa-eyebrow-row">
            {!useStepper ? (
              <span className="qa-eyebrow">{question.header}</span>
            ) : (
              <span />
            )}
            <div className="qa-eyebrow-meta">
              {multi ? <span className="qa-multi-hint">{t('可多选', 'Multi-select')}</span> : null}
              {!editable ? (
                <span className="qa-readonly-tag">{t('只读', 'Read-only')}</span>
              ) : null}
              {!useStepper && embeddedBubble && onDismissBubble ? (
                <button
                  type="button"
                  className="qa-dismiss-btn"
                  title={t('收起气泡', 'Dismiss')}
                  aria-label={t('收起气泡', 'Dismiss')}
                  onClick={onDismissBubble}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <legend className="qa-prompt">{question.question}</legend>
        <div className="tp-options qa-options" role="group" aria-label={questionScope}>
          {question.options.map((option, optionIndex) => {
            const checked = selected.includes(optionIndex);
            return (
              <label key={optionIndex} className={`qa-opt${checked ? ' is-selected' : ''}`}>
                <input
                  className="qa-sr-input"
                  type={multi ? 'checkbox' : 'radio'}
                  name={groupName}
                  checked={checked}
                  disabled={inputDisabled}
                  onChange={() => toggleOption(index, optionIndex, multi)}
                />
                <span className={`qa-indicator${multi ? ' is-check' : ''}`} aria-hidden="true">
                  {multi ? (
                    <Check size={11} strokeWidth={3.1} aria-hidden="true" />
                  ) : (
                    <span className="qa-indicator-dot" />
                  )}
                </span>
                <span className="qa-opt-text">
                  <span className="qa-opt-label">{option.label}</span>
                  <span className="qa-opt-desc">{option.description}</span>
                </span>
                <span className="qa-opt-key tabular-nums" aria-hidden="true">{optionIndex + 1}</span>
              </label>
            );
          })}

          <div className={`qa-custom-row${customActive ? ' is-active' : ''}`}>
            <button
              type="button"
              className="qa-custom-trigger"
              disabled={inputDisabled}
              aria-expanded={customActive}
              onClick={() => toggleCustomRow(index, multi)}
            >
              <span className={`qa-indicator${multi ? ' is-check' : ''}`} aria-hidden="true">
                {customActive ? (
                  multi ? <Check size={11} strokeWidth={3.1} aria-hidden="true" /> : <span className="qa-indicator-dot" />
                ) : null}
              </span>
              <span className="qa-custom-label">{t('其他，自己输入…', 'Other, write your own…')}</span>
            </button>
            {customActive ? (
              <input
                ref={el => { customInputRefs.current[index] = el; }}
                type="text"
                className="qa-custom-input"
                aria-label={t(`${questionScope}：自定义回答（可选）`, `${questionScope}: Custom answer (optional)`)}
                placeholder={t('输入你的想法…', 'Type your answer…')}
                value={customText}
                maxLength={CUSTOM_TEXT_LIMIT}
                disabled={inputDisabled}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid && error ? errorId : undefined}
                onChange={event => changeCustomText(index, multi, event.target.value)}
              />
            ) : null}
          </div>
        </div>

        {/* preview 只限单选选项（上游契约）；multi 的 preview 字段不渲染。 */}
        {!multi && question.options.map((option, optionIndex) =>
          option.preview && selected.includes(optionIndex) ? (
            <OptionPreview key={`preview-${optionIndex}`} preview={option.preview} />
          ) : null,
        )}
      </fieldset>
    );
  };

  if (!isPendingView) {
    const cancelled = interrupted || presentation.result?.cancelled || presentation.status === 'cancelled';
    const receiptTitle = interrupted
      ? t('已中断', 'Interrupted')
      : settledLocally
        ? t('已结算（以先到回答为准）', 'Settled (first answer won)')
        : cancelled
          ? t('已取消', 'Cancelled')
          : t('已确认', 'Confirmed');
    const answers = presentation.result?.answers ?? [];

    return (
      <div className="tp-questionnaire-wrap">
        <section
          role="group"
          aria-label={t('问卷结果', 'Questionnaire result')}
          className={`qa-card is-${displayStatus}${embeddedBubble ? ' is-bubble' : ''}`}
        >
          <div className="qa-receipt">
            <div className="qa-receipt-head">
              <span
                role="status"
                className={`qa-receipt-status${cancelled ? ' is-cancelled' : ''}`}
              >
                {cancelled ? (
                  <X size={13} aria-hidden="true" />
                ) : (
                  <Check size={14} strokeWidth={2.6} aria-hidden="true" />
                )}
                <span>{receiptTitle}</span>
              </span>
              {embeddedBubble && onDismissBubble ? (
                <button
                  type="button"
                  className="qa-dismiss-btn"
                  title={t('收起气泡', 'Dismiss')}
                  aria-label={t('收起气泡', 'Dismiss')}
                  onClick={onDismissBubble}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>

            {interrupted ? (
              <div className="qa-receipt-empty">{t('该问卷已中断，无法继续提交。', 'This questionnaire was interrupted.')}</div>
            ) : settledLocally ? (
              <div className="qa-receipt-empty">
                {t('该请求已被其他提交结算，回答以先到者为准。', 'This request was already settled; the first answer won.')}
              </div>
            ) : cancelled && answers.length === 0 ? (
              <div className="qa-receipt-empty">{t('用户已取消该问卷。', 'The questionnaire was cancelled.')}</div>
            ) : null}

            {answers.length > 0 ? (
              <div className="qa-receipt-rows">
                {answers.map((answer: QuestionnaireAnswerPresentation, index) => {
                  const matchedHeader = presentation.questions[answer.questionIndex]?.header;
                  const valueText =
                    answer.kind === 'multi' && answer.selected?.length
                      ? answer.answer
                        ? `${answer.selected.join(t('、', ', '))}${t('、', ', ')}${answer.answer}`
                        : answer.selected.join(t('、', ', '))
                      : answer.answer ?? t('（未回答）', '(unanswered)');
                  return (
                    <div key={index} className="qa-receipt-item">
                      <div className="qa-receipt-row">
                        <span className="qa-receipt-q" title={answer.question}>
                          {matchedHeader || answer.question || `#${answer.questionIndex + 1}`}
                        </span>
                        <span className="qa-receipt-a">{valueText}</span>
                      </div>
                      {answer.notes ? (
                        <div className="qa-receipt-subnote">{t('备注：', 'Notes: ')}{answer.notes}</div>
                      ) : null}
                      {answer.preview ? <OptionPreview preview={answer.preview} /> : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {presentation.result?.unanswered?.length ? (
              <div className="qa-receipt-empty tabular-nums">
                {presentation.result.unanswered.length}{t(' 题未回答', ' unanswered')}
              </div>
            ) : null}
            {presentation.result?.globalNote ? (
              <div className="qa-receipt-note">{t('补充：', 'Note: ')}{presentation.result.globalNote}</div>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div
      className="tp-questionnaire-wrap"
      data-active-questionnaire={editable && !busy && !settledLocally ? presentation.requestId : undefined}
    >
      <section
        role="group"
        aria-label={t('问卷', 'Questionnaire')}
        className={`qa-card is-${displayStatus}${embeddedBubble ? ' is-bubble' : ''}`}
      >
        {useStepper ? (
          <div className="qa-stepper">
            <div className="qa-steps" role="tablist" aria-label={t('问题步骤', 'Question steps')}>
              {presentation.questions.map((question, idx) => {
                const done = isQuestionAnswered(idx);
                const current = idx === clampedStep;
                return (
                  <button
                    key={idx}
                    type="button"
                    role="tab"
                    aria-selected={current}
                    className={`qa-step-pill${current ? ' is-current' : ''}${done ? ' is-done' : ''}`}
                    onClick={() => goToStep(idx)}
                  >
                    <span className="qa-step-num tabular-nums" aria-hidden="true">
                      {done && !current ? <Check size={10} strokeWidth={3} /> : idx + 1}
                    </span>
                    <span className="qa-step-label">{question.header}</span>
                  </button>
                );
              })}
            </div>
            <div className="qa-stepper-right">
              <span className="qa-step-counter tabular-nums">
                {clampedStep + 1}/{totalQuestions}
              </span>
              {embeddedBubble && onDismissBubble ? (
                <button
                  type="button"
                  className="qa-dismiss-btn"
                  title={t('收起气泡', 'Dismiss')}
                  aria-label={t('收起气泡', 'Dismiss')}
                  onClick={onDismissBubble}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="qa-body">
          {renderQuestion(clampedStep)}

          {noteOpen ? (
            <div className="qa-note-box">
              <input
                ref={noteInputRef}
                type="text"
                className="qa-note-input"
                aria-label={t('整体备注（可选）', 'Overall note (optional)')}
                placeholder={t('添加补充说明（可选）…', 'Add an overall note (optional)…')}
                value={globalNote}
                maxLength={GLOBAL_NOTE_LIMIT}
                disabled={inputDisabled}
                onChange={event => { setGlobalNote(event.target.value); clearError(); }}
              />
            </div>
          ) : null}

          {error ? (
            <div id={errorId} className="tp-error-wrap">
              <InlineBanner tone="danger" role="alert" compact title={error} />
            </div>
          ) : null}
        </div>

        <footer className="qa-footer">
          <div className="qa-foot-left">
            <button
              type="button"
              className={`qa-note-btn${globalNote.trim() ? ' is-has' : ''}`}
              disabled={inputDisabled}
              aria-expanded={noteOpen}
              onClick={() => {
                const next = !noteOpen;
                setNoteOpen(next);
                if (next) requestAnimationFrame(() => noteInputRef.current?.focus());
              }}
            >
              <MessageSquarePlus size={13} aria-hidden="true" />
              <span>{globalNote.trim() ? t('已添说明', 'Note added') : t('补充说明', 'Add note')}</span>
            </button>
          </div>
          <div className="qa-foot-right">
            <button
              type="button"
              className="qa-btn-ghost"
              disabled={!editable || busy}
              onClick={() => void handleSubmit(true)}
            >
              {t('取消', 'Cancel')}
            </button>
            {useStepper ? (
              <button
                type="button"
                className="qa-btn-secondary"
                disabled={clampedStep <= 0 || busy}
                onClick={() => goToStep(clampedStep - 1)}
              >
                <ArrowLeft size={13} aria-hidden="true" />
                <span>{t('上一题', 'Back')}</span>
              </button>
            ) : null}
            {useStepper && !isLastStep ? (
              <button
                type="button"
                className="qa-btn-primary tp-btn-primary"
                disabled={busy}
                onClick={() => goToStep(clampedStep + 1)}
              >
                <span>{t('下一题', 'Next')}</span>
                <ArrowRight size={13} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="qa-btn-primary tp-btn-primary"
                disabled={!editable || busy}
                aria-describedby={error ? errorId : undefined}
                onClick={() => void handleSubmit(false)}
              >
                {submitting
                  ? t('提交中…', 'Submitting…')
                  : submitted
                    ? t('已提交', 'Submitted')
                    : useStepper
                      ? `${t('确认提交', 'Submit')} (${answeredCount}/${totalQuestions})`
                      : t('确认提交', 'Submit')}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
