import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type {
  ToolPresentation,
  TodoPresentation,
  QuestionnairePresentation,
  QuestionnaireAnswerPresentation,
} from '../../host-core/index.js';
import { useText } from './ui';
import './tool-presentation.css';

/**
 * 工具交互呈现：消费 host LiveTool/LiveMessage 上有界白名单投影的 presentation。
 * live 帧已由 remote-live-protocol 严格校验；raw 历史直接读取 entry.model 的
 * toolResult.details.presentation 原文。这里按契约做最终把关：kind+version 严格
 * 匹配、字段类型核验、未知字段与畸形值整体拒绝——不 trim/filter/重排，
 * 选项索引与原文必须与服务端保存的问卷一一对应。
 * 类型 type-only 引用 host-core 契约，不维护重复接口。
 */

export type { ToolPresentation, TodoPresentation, QuestionnairePresentation };

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
const NOTES_LIMIT = 2000;
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

/**
 * 从 live slot / 历史消息上识别 presentation；严格 kind+version 白名单核验，
 * 任何不合规结构整体返回 null——不裁剪、不填默认值，选项保持原文原序。
 * wire（live）值已过 normalizeToolPresentation，raw 历史值按同一契约把关。
 */
export function readToolPresentation(value: unknown): ToolPresentation | null {
  if (!isRecord(value) || value.version !== 1 || !isNonEmptyString(value.installationId)) return null;
  if (value.kind === 'todo') {
    if (!Array.isArray(value.tasks) || !value.tasks.every(checkTodoTask)) return null;
    return value as unknown as TodoPresentation;
  }
  if (value.kind === 'questionnaire') {
    if (!isNonEmptyString(value.requestId)) return null;
    if (value.status !== 'pending' && value.status !== 'answered' && value.status !== 'cancelled') return null;
    if (!isInt(value.conversationId)) return null;
    if (!Array.isArray(value.questions) || value.questions.length < 1 || !value.questions.every(checkQuestion)) return null;
    if (value.result !== undefined && !checkResult(value.result)) return null;
    return value as unknown as QuestionnairePresentation;
  }
  return null;
}

export interface ToolPresentationCardProps {
  presentation: ToolPresentation;
  /** 仍活跃工具的 pending 问卷才可提交；历史 answered/cancelled 一律只读。 */
  active: boolean;
  disabled?: boolean;
  onSubmit?: (input: QuestionnaireSubmitPayload) => Promise<unknown>;
}

export function ToolPresentationCard({ presentation, active, disabled = false, onSubmit }: ToolPresentationCardProps) {
  const t = useText();
  if (presentation.kind === 'todo') {
    return <TodoCard presentation={presentation} t={t} />;
  }
  return (
    <QuestionnaireCard
      presentation={presentation}
      active={active && presentation.status === 'pending' && Boolean(onSubmit)}
      disabled={disabled}
      onSubmit={onSubmit}
      t={t}
    />
  );
}

function TodoCard({ presentation, t }: { presentation: TodoPresentation; t: (zh: string, en: string) => string }) {
  const done = presentation.tasks.filter(task => task.status === 'completed').length;
  return (
    <div className="tp-card tp-todo" role="group" aria-label={t('任务列表', 'Task list')}>
      <div className="tp-card-head">
        <span className="tp-card-title">{t('任务列表', 'Tasks')}</span>
        <span className="tp-card-meta">{done}/{presentation.tasks.length}</span>
      </div>
      <ul className="tp-todo-list">
        {presentation.tasks.map(task => (
          <li key={task.id} className={`tp-todo-item is-${task.status}`}>
            <span className="tp-todo-icon" aria-hidden="true">
              {task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◐' : '○'}
            </span>
            <span className="tp-todo-subject">{task.subject}</span>
          </li>
        ))}
        {presentation.tasks.length === 0 ? (
          <li className="tp-todo-empty">{t('暂无任务', 'No tasks')}</li>
        ) : null}
      </ul>
    </div>
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
  onSubmit,
  t,
}: {
  presentation: QuestionnairePresentation;
  active: boolean;
  disabled: boolean;
  onSubmit?: (input: QuestionnaireSubmitPayload) => Promise<unknown>;
  t: (zh: string, en: string) => string;
}) {
  const editable = active && !disabled;
  const [localStatus, setLocalStatus] = useState<'settled' | null>(null);
  const [selectedMap, setSelectedMap] = useState<Record<number, number[]>>({});
  const [customTextMap, setCustomTextMap] = useState<Record<number, string>>({});
  const [notesMap, setNotesMap] = useState<Record<number, string>>({});
  const [globalNote, setGlobalNote] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /** 成功提交后保持锁定直到 live/历史终态卡片替换，防双击重复提交。 */
  const [submitted, setSubmitted] = useState(false);
  /** 同一 tick 内防重入：state 更新晚于同步 onChange 链。 */
  const submittingRef = useRef(false);
  const busy = submitting || submitted;

  const selectedFor = (index: number): number[] => selectedMap[index] ?? [];
  const clearError = () => { if (error) setError(''); };

  const toggleOption = (questionIndex: number, optionIndex: number, multi: boolean) => {
    setSelectedMap(prev => {
      const current = prev[questionIndex] ?? [];
      const next = multi
        ? current.includes(optionIndex)
          ? current.filter(i => i !== optionIndex)
          : [...current, optionIndex]
        : [optionIndex];
      return { ...prev, [questionIndex]: next };
    });
    // 单选下 custom 与选项互斥：点选项即清掉已输入的自定义文本。
    if (!multi) {
      setCustomTextMap(prev => (prev[questionIndex] ? { ...prev, [questionIndex]: '' } : prev));
    }
    clearError();
  };

  const changeCustomText = (questionIndex: number, multi: boolean, text: string) => {
    setCustomTextMap(prev => ({ ...prev, [questionIndex]: text }));
    // 单选下输入 custom 即清空已选选项；multi 允许 selected + custom 并存。
    if (!multi && text !== '') {
      setSelectedMap(prev => ((prev[questionIndex] ?? []).length > 0 ? { ...prev, [questionIndex]: [] } : prev));
    }
    clearError();
  };

  const buildAnswers = () =>
    presentation.questions
      .map((question, index) => {
        const selected = selectedFor(index);
        const customText = (customTextMap[index] ?? '').trim();
        const notes = (notesMap[index] ?? '').trim();
        if (selected.length === 0 && !customText && !notes) return null;
        const next: QuestionnaireSubmitPayload['answers'][number] = { questionIndex: index };
        if (selected.length > 0) next.selectedOptions = selected;
        if (customText) next.customText = customText;
        if (notes) next.notes = notes;
        return next;
      })
      .filter((a): a is QuestionnaireSubmitPayload['answers'][number] => a !== null);

  const handleSubmit = async (cancelled: boolean) => {
    if (!editable || !onSubmit || submittingRef.current || submitted) return;
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

  const statusLabel =
    presentation.status === 'answered'
      ? t('已回答', 'Answered')
      : presentation.status === 'cancelled'
        ? t('已取消', 'Cancelled')
        : settledLocally
          ? t('已结算（以先到回答为准）', 'Settled (first answer won)')
          : editable
            ? t('待回答', 'Pending')
            : t('待回答（只读）', 'Pending (read-only)');

  return (
    <div className={`tp-card tp-questionnaire is-${presentation.status}`} role="group" aria-label={t('问卷', 'Questionnaire')}>
      <div className="tp-card-head">
        <span className="tp-card-title">{t('问卷', 'Questions')}</span>
        <span className={`tp-status-pill is-${presentation.status}`}>{statusLabel}</span>
      </div>

      {presentation.status === 'pending' ? (
        <div className="tp-questions">
          {presentation.questions.map((question, index) => {
            const selected = selectedFor(index);
            const groupName = `tp-q-${presentation.requestId}-${index}`;
            const inputDisabled = !editable || busy || settledLocally;
            const multi = question.multiSelect === true;
            return (
              <fieldset key={index} className="tp-question" disabled={inputDisabled}>
                <legend className="tp-question-text">
                  <span className="tp-question-header">{question.header} · </span>
                  {question.question}
                  {multi ? <span className="tp-question-hint">{t('（可多选）', ' (multi)')}</span> : null}
                </legend>
                <div className="tp-options" role="group">
                  {question.options.map((option, optionIndex) => {
                    const checked = selected.includes(optionIndex);
                    return (
                      <label key={optionIndex} className={`tp-option${checked ? ' is-selected' : ''}`}>
                        <input
                          type={multi ? 'checkbox' : 'radio'}
                          name={groupName}
                          checked={checked}
                          disabled={inputDisabled}
                          onChange={() => toggleOption(index, optionIndex, multi)}
                        />
                        <span className="tp-option-body">
                          <span className="tp-option-label">{option.label}</span>
                          <span className="tp-option-desc">{option.description}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {/* preview 只限单选选项（上游契约）；multi 的 preview 字段不渲染。 */}
                {!multi && question.options.map((option, optionIndex) =>
                  option.preview && selected.includes(optionIndex) ? (
                    <OptionPreview key={`preview-${optionIndex}`} preview={option.preview} />
                  ) : null,
                )}
                <input
                  type="text"
                  className="tp-input"
                  placeholder={t('自定义回答（可选）', 'Custom answer (optional)')}
                  value={customTextMap[index] ?? ''}
                  maxLength={CUSTOM_TEXT_LIMIT}
                  disabled={inputDisabled}
                  onChange={event => changeCustomText(index, multi, event.target.value)}
                />
                <input
                  type="text"
                  className="tp-input tp-notes"
                  placeholder={t('备注（可选）', 'Notes (optional)')}
                  value={notesMap[index] ?? ''}
                  maxLength={NOTES_LIMIT}
                  disabled={inputDisabled}
                  onChange={event => { setNotesMap(prev => ({ ...prev, [index]: event.target.value })); clearError(); }}
                />
              </fieldset>
            );
          })}
          <input
            type="text"
            className="tp-input tp-global-note"
            placeholder={t('整体备注（可选）', 'Overall note (optional)')}
            value={globalNote}
            maxLength={GLOBAL_NOTE_LIMIT}
            disabled={!editable || busy || settledLocally}
            onChange={event => { setGlobalNote(event.target.value); clearError(); }}
          />
          {error ? <div className="tp-error" role="alert">{error}</div> : null}
          {settledLocally ? (
            <div className="tp-result-line">{t('该请求已被其他提交结算，回答以先到者为准。', 'This request was already settled; the first answer won.')}</div>
          ) : (
            <div className="tp-actions">
              <button
                type="button"
                className="tp-btn tp-btn-primary"
                disabled={!editable || busy}
                onClick={() => void handleSubmit(false)}
              >
                {submitting ? t('提交中…', 'Submitting…') : submitted ? t('已提交，等待确认', 'Submitted, awaiting confirmation') : t('提交回答', 'Submit')}
              </button>
              <button
                type="button"
                className="tp-btn"
                disabled={!editable || busy}
                onClick={() => void handleSubmit(true)}
              >
                {t('取消问卷', 'Cancel')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="tp-result">
          {presentation.result?.cancelled || presentation.status === 'cancelled' ? (
            <div className="tp-result-line">{t('用户已取消该问卷。', 'The questionnaire was cancelled.')}</div>
          ) : null}
          {presentation.result?.answers.map((answer: QuestionnaireAnswerPresentation, index) => (
            <div key={index} className="tp-answer">
              <div className="tp-answer-question">{answer.question || `#${answer.questionIndex + 1}`}</div>
              <div className="tp-answer-value">
                {/* multi 同时显示 selected 与自定义文本；option/custom 显示标量答案。 */}
                {answer.kind === 'multi' && answer.selected?.length
                  ? answer.answer
                    ? `${answer.selected.join('、')}、${answer.answer}`
                    : answer.selected.join('、')
                  : answer.answer ?? t('（未回答）', '(unanswered)')}
              </div>
              {answer.notes ? <div className="tp-answer-notes">{t('备注：', 'Notes: ')}{answer.notes}</div> : null}
              {answer.preview ? <OptionPreview preview={answer.preview} /> : null}
            </div>
          ))}
          {presentation.result?.unanswered?.length ? (
            <div className="tp-result-line">
              {presentation.result.unanswered.length}{t(' 题未回答', ' unanswered')}
            </div>
          ) : null}
          {presentation.result?.globalNote ? (
            <div className="tp-answer-notes">{t('整体备注：', 'Note: ')}{presentation.result.globalNote}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
