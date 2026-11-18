// host-core/tool-presentation.js
// Tool presentation contract: the ONLY UI structure a tool may publish through
// result.details.presentation / api.details({presentation}). Supported kinds are
// 'todo', 'questionnaire', 'vault-unlock' and 'task'; anything else (kind, version, field shape or
// wire byte budget) is dropped by the live projection, never forwarded.
//
// Pure module: no I/O, no Session/Runtime/storage. Shared by
// runtime-live-projection (trusted tool output -> bounded projection) and
// remote-live-protocol (untrusted wire -> strict validation). The five lanes
// therefore accept exactly one shape; tools cannot smuggle arbitrary details,
// arguments or credentials through this field.
//
// Durable 1.4 placement (verified in pi-durable/dist/harness): running calls
// keep details on the pi.live tool slot (cleared by finishSlot); settled
// model-issued calls keep details on the toolResult message in entry.model —
// entry.data only stores diagnostics. Abort/interrupt synthesize the result
// from the slot via fromSlot, preserving slot.details, so a cancelled tool
// still carries its last published presentation into history.

import { messageError } from './message-protocol.js';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';

/** Hard ceiling for one presentation's strict whitelist JSON (UTF-8 bytes). */
export const TOOL_PRESENTATION_MAX_BYTES = 49152; // 48 KiB

export const TODO_MAX_TASKS = 100;
export const TODO_SUBJECT_MAX_UNITS = 200;

export const QUESTIONNAIRE_MAX_QUESTIONS = 4;
export const QUESTIONNAIRE_MAX_OPTIONS = 4;
export const QUESTIONNAIRE_HEADER_MAX_UNITS = 16;
export const QUESTIONNAIRE_OPTION_LABEL_MAX_UNITS = 60;
// rpiv-ask-user-question parity; not rendered live but kept consistent.
export const QUESTIONNAIRE_QUESTION_MAX_UNITS = 600;
export const QUESTIONNAIRE_OPTION_DESCRIPTION_MAX_UNITS = 600;
export const QUESTIONNAIRE_PREVIEW_MAX_UNITS = 4000;
// 与 answerQuestionnaire action 一致：问卷最多 4 题/4 选项，文本回答 2000。
export const QUESTIONNAIRE_MAX_ANSWERS = 4;
export const QUESTIONNAIRE_ANSWER_MAX_UNITS = 2000;
export const QUESTIONNAIRE_MAX_SELECTED = 4;
export const QUESTIONNAIRE_MAX_UNANSWERED = 4;

// 1 MiB is the existing id/text wire convention; requestId/installationId are
// asserted the same way as remote-control-protocol params.
const MAX_ID_BYTES = 1024;

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const QUESTIONNAIRE_STATUSES = new Set(['pending', 'answered', 'cancelled']);
const VAULT_UNLOCK_STATUSES = new Set(['pending', 'unlocked', 'cancelled', 'interrupted']);
const ANSWER_KINDS = new Set(['option', 'custom', 'multi']);
const TASK_STATUSES = new Set(['triaging', 'working', 'waiting', 'done', 'cancelled']);
const TASK_STEP_STATUSES = new Set(['unassigned', 'todo', 'working', 'waiting', 'blocked', 'done', 'cancelled']);
const TASK_PROMPT_KINDS = new Set(['plan', 'question']);

export const TASK_ID_MAX_UNITS = 128;
export const TASK_TITLE_MAX_UNITS = 300;
export const TASK_CARD_LABEL_MAX_UNITS = 120;
export const TASK_SUMMARY_MAX_UNITS = 500;
export const TASK_PROMPT_TEXT_MAX_UNITS = 1000;
export const TASK_PROMPT_MAX_OPTIONS = 8;
export const TASK_STEPS_PREVIEW_MAX = 20;
export const TASK_STEP_TEXT_MAX_UNITS = 300;
export const TASK_BOT_NAME_MAX_UNITS = 80;

const TOP_KEYS = {
  todo: new Set(['kind', 'version', 'installationId', 'tasks']),
  'vault-unlock': new Set([
    'kind', 'version', 'installationId', 'conversationId', 'requestId', 'mode', 'status',
    'source', 'serverUrl',
  ]),
  questionnaire: new Set([
    'kind',
    'version',
    'installationId',
    'conversationId',
    'requestId',
    'status',
    'questions',
    'result',
  ]),
  task: new Set([
    'kind',
    'version',
    'installationId',
    'taskId',
    'title',
    'status',
    'cardLabel',
    'summary',
    'stepCount',
    'pendingPrompt',
    'stepsPreview',
  ]),
};
const TASK_STEP_COUNT_KEYS = new Set(['done', 'total']);
const TASK_PENDING_PROMPT_KEYS = new Set(['kind', 'botId', 'text', 'options']);
const TASK_STEP_PREVIEW_KEYS = new Set(['id', 'text', 'status', 'botName']);
const TODO_TASK_KEYS = new Set(['id', 'subject', 'status']);
const QUESTION_KEYS = new Set(['question', 'header', 'multiSelect', 'options']);
const OPTION_KEYS = new Set(['label', 'description', 'preview']);
const RESULT_KEYS = new Set(['answers', 'cancelled', 'globalNote', 'unanswered']);
const ANSWER_KEYS = new Set([
  'questionIndex',
  'question',
  'kind',
  'answer',
  'selected',
  'notes',
  'preview',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, onError) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) onError('unknown field: ' + key);
  }
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function checkText(value, maxUnits, minLength, onError) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length < minLength) {
    onError('must be a well-formed string');
  }
  if (value.length > maxUnits) onError('exceeds the length limit');
}

function checkId(value, onError) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.trim() === '' ||
    utf8Bytes(value) > MAX_ID_BYTES
  ) {
    onError('must be a well-formed non-blank string of at most 1024 UTF-8 bytes');
  }
}

function checkTodo(task, onError) {
  if (!isPlainObject(task)) onError('todo task must be an object');
  rejectUnknownFields(task, TODO_TASK_KEYS, onError);
  if (!Number.isSafeInteger(task.id) || task.id < 0) onError('todo task id must be a nonnegative safe integer');
  checkText(task.subject, TODO_SUBJECT_MAX_UNITS, 1, onError);
  if (!TODO_STATUSES.has(task.status)) onError('todo task status must be pending, in_progress or completed');
}

function checkOption(option, onError) {
  if (!isPlainObject(option)) onError('option must be an object');
  rejectUnknownFields(option, OPTION_KEYS, onError);
  checkText(option.label, QUESTIONNAIRE_OPTION_LABEL_MAX_UNITS, 1, onError);
  checkText(option.description, QUESTIONNAIRE_OPTION_DESCRIPTION_MAX_UNITS, 1, onError);
  if (option.preview !== undefined) checkText(option.preview, QUESTIONNAIRE_PREVIEW_MAX_UNITS, 0, onError);
}

function checkQuestion(question, onError) {
  if (!isPlainObject(question)) onError('question must be an object');
  rejectUnknownFields(question, QUESTION_KEYS, onError);
  checkText(question.question, QUESTIONNAIRE_QUESTION_MAX_UNITS, 1, onError);
  checkText(question.header, QUESTIONNAIRE_HEADER_MAX_UNITS, 1, onError);
  if (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') {
    onError('question multiSelect must be a boolean');
  }
  if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > QUESTIONNAIRE_MAX_OPTIONS) {
    onError('question options must hold 2-4 items');
  }
  for (const option of question.options) checkOption(option, onError);
}

function checkAnswer(answer, onError) {
  if (!isPlainObject(answer)) onError('answer must be an object');
  rejectUnknownFields(answer, ANSWER_KEYS, onError);
  if (!Number.isSafeInteger(answer.questionIndex) || answer.questionIndex < 0) {
    onError('answer questionIndex must be a nonnegative safe integer');
  }
  checkText(answer.question, QUESTIONNAIRE_QUESTION_MAX_UNITS, 1, onError);
  if (!ANSWER_KINDS.has(answer.kind)) onError('answer kind must be option, custom or multi');
  // answer is required; null means the question was skipped, a string carries it.
  if (answer.answer === undefined) {
    onError('answer must carry an answer field');
  } else if (answer.answer !== null) {
    checkText(answer.answer, QUESTIONNAIRE_ANSWER_MAX_UNITS, 0, onError);
  }
  if (answer.selected !== undefined) {
    if (!Array.isArray(answer.selected) || answer.selected.length > QUESTIONNAIRE_MAX_SELECTED) {
      onError('answer selected must be an array of at most 4 items');
    } else {
      for (const item of answer.selected) checkText(item, QUESTIONNAIRE_OPTION_LABEL_MAX_UNITS, 1, onError);
    }
  }
  if (answer.notes !== undefined) checkText(answer.notes, QUESTIONNAIRE_ANSWER_MAX_UNITS, 0, onError);
  if (answer.preview !== undefined) checkText(answer.preview, QUESTIONNAIRE_PREVIEW_MAX_UNITS, 0, onError);
}

function checkResult(result, onError) {
  if (!isPlainObject(result)) onError('questionnaire result must be an object');
  rejectUnknownFields(result, RESULT_KEYS, onError);
  if (!Array.isArray(result.answers) || result.answers.length > QUESTIONNAIRE_MAX_ANSWERS) {
    onError('result answers must be an array of at most 4 items');
  }
  for (const answer of result.answers) checkAnswer(answer, onError);
  if (typeof result.cancelled !== 'boolean') onError('result cancelled must be a boolean');
  if (result.globalNote !== undefined) checkText(result.globalNote, QUESTIONNAIRE_ANSWER_MAX_UNITS, 0, onError);
  if (result.unanswered !== undefined) {
    if (!Array.isArray(result.unanswered) || result.unanswered.length > QUESTIONNAIRE_MAX_UNANSWERED) {
      onError('result unanswered must be an array of at most 4 items');
    } else {
      for (const index of result.unanswered) {
        if (!Number.isSafeInteger(index) || index < 0) onError('result unanswered items must be nonnegative safe integers');
      }
    }
  }
}

function checkTaskStepCount(stepCount, onError) {
  if (!isPlainObject(stepCount)) {
    onError('task stepCount must be an object');
    return;
  }
  rejectUnknownFields(stepCount, TASK_STEP_COUNT_KEYS, onError);
  if (!Number.isSafeInteger(stepCount.done) || stepCount.done < 0) {
    onError('task stepCount.done must be a nonnegative safe integer');
  }
  if (!Number.isSafeInteger(stepCount.total) || stepCount.total < 0) {
    onError('task stepCount.total must be a nonnegative safe integer');
  }
}

function checkTaskPendingPrompt(prompt, onError) {
  if (prompt === null) return;
  if (!isPlainObject(prompt)) {
    onError('task pendingPrompt must be null or an object');
    return;
  }
  rejectUnknownFields(prompt, TASK_PENDING_PROMPT_KEYS, onError);
  if (!TASK_PROMPT_KINDS.has(prompt.kind)) onError('task pendingPrompt.kind must be plan or question');
  checkId(prompt.botId, onError);
  checkText(prompt.text, TASK_PROMPT_TEXT_MAX_UNITS, 0, onError);
  if (prompt.options !== undefined) {
    if (!Array.isArray(prompt.options) || prompt.options.length > TASK_PROMPT_MAX_OPTIONS) {
      onError('task pendingPrompt.options must be an array of at most 8 items');
    } else {
      for (const opt of prompt.options) checkText(opt, 500, 0, onError);
    }
  }
}

function checkTaskStepPreview(step, onError) {
  if (!isPlainObject(step)) {
    onError('task stepsPreview item must be an object');
    return;
  }
  rejectUnknownFields(step, TASK_STEP_PREVIEW_KEYS, onError);
  checkText(step.id, TASK_ID_MAX_UNITS, 1, onError);
  if (typeof step.id === 'string' && step.id.trim() === '') onError('task stepsPreview step.id must be non-blank');
  checkText(step.text, TASK_STEP_TEXT_MAX_UNITS, 0, onError);
  if (!TASK_STEP_STATUSES.has(step.status)) onError('task stepsPreview step.status is invalid');
  if (step.botName !== undefined) checkText(step.botName, TASK_BOT_NAME_MAX_UNITS, 0, onError);
}

// kind/version gate first; the byte budget is enforced on the projected
// whitelist output, so unknown keys can never consume the budget.
/** 序列化 presentation 的 UTF-8 字节数；不可序列化返回 Infinity。 */
export function toolPresentationBytes(presentation) {
  try {
    return utf8Bytes(JSON.stringify(presentation));
  } catch {
    return Infinity;
  }
}

function checkPresentation(value, onError) {
  if (!isPlainObject(value)) onError('presentation must be an object');
  if (value.version !== 1) onError('presentation version must be 1');
  if (value.kind === 'todo') {
    rejectUnknownFields(value, TOP_KEYS.todo, onError);
    checkId(value.installationId, onError);
    if (!Array.isArray(value.tasks) || value.tasks.length > TODO_MAX_TASKS) {
      onError('todo tasks must be an array of at most 100 items');
    }
    for (const task of value.tasks) checkTodo(task, onError);
    return;
  }
  if (value.kind === 'questionnaire') {
    rejectUnknownFields(value, TOP_KEYS.questionnaire, onError);
    checkId(value.installationId, onError);
    checkId(value.requestId, onError);
    if (!Number.isSafeInteger(value.conversationId) || value.conversationId < 0) {
      onError('questionnaire conversationId must be a nonnegative safe integer');
    }
    if (!QUESTIONNAIRE_STATUSES.has(value.status)) {
      onError('questionnaire status must be pending, answered or cancelled');
    }
    if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > QUESTIONNAIRE_MAX_QUESTIONS) {
      onError('questionnaire questions must hold 1-4 items');
    }
    for (const question of value.questions) checkQuestion(question, onError);
    if (value.result !== undefined) checkResult(value.result, onError);
    return;
  }
  if (value.kind === 'vault-unlock') {
    rejectUnknownFields(value, TOP_KEYS['vault-unlock'], onError);
    checkId(value.installationId, onError);
    checkId(value.requestId, onError);
    if (!Number.isSafeInteger(value.conversationId) || value.conversationId < 0) {
      onError('vault-unlock conversationId must be a nonnegative safe integer');
    }
    if (value.mode !== 'initialize' && value.mode !== 'unlock') {
      onError('vault-unlock mode must be initialize or unlock');
    }
    if (!VAULT_UNLOCK_STATUSES.has(value.status)) {
      onError('vault-unlock status must be pending, unlocked, cancelled or interrupted');
    }
    if (value.source !== undefined && value.source !== 'local' && value.source !== 'vaultwarden') {
      onError('vault-unlock source must be local or vaultwarden');
    }
    if (value.serverUrl !== undefined) checkText(value.serverUrl, 2048, 1, onError);
    return;
  }
  if (value.kind === 'task') {
    rejectUnknownFields(value, TOP_KEYS.task, onError);
    checkId(value.installationId, onError);
    checkText(value.taskId, TASK_ID_MAX_UNITS, 1, onError);
    if (typeof value.taskId === 'string' && value.taskId.trim() === '') onError('taskId must be non-blank');
    checkText(value.title, TASK_TITLE_MAX_UNITS, 0, onError);
    if (!TASK_STATUSES.has(value.status)) {
      onError('task status must be triaging, working, waiting, done or cancelled');
    }
    checkText(value.cardLabel, TASK_CARD_LABEL_MAX_UNITS, 0, onError);
    if (value.summary !== undefined) checkText(value.summary, TASK_SUMMARY_MAX_UNITS, 0, onError);
    checkTaskStepCount(value.stepCount, onError);
    if (value.pendingPrompt !== undefined) checkTaskPendingPrompt(value.pendingPrompt, onError);
    if (value.stepsPreview !== undefined) {
      if (!Array.isArray(value.stepsPreview) || value.stepsPreview.length > TASK_STEPS_PREVIEW_MAX) {
        onError('task stepsPreview must be an array of at most 20 items');
      } else {
        for (const step of value.stepsPreview) checkTaskStepPreview(step, onError);
      }
    }
    return;
  }
  onError('presentation kind must be todo, questionnaire, vault-unlock or task');
}

function buildPresentation(value) {
  if (value.kind === 'todo') {
    return {
      kind: 'todo',
      version: 1,
      installationId: value.installationId,
      tasks: value.tasks.map((task) => ({ id: task.id, subject: task.subject, status: task.status })),
    };
  }
  if (value.kind === 'vault-unlock') {
    const presentation = {
      kind: 'vault-unlock',
      version: 1,
      installationId: value.installationId,
      conversationId: value.conversationId,
      requestId: value.requestId,
      mode: value.mode,
      status: value.status,
    };
    if (value.source !== undefined) presentation.source = value.source;
    if (value.serverUrl !== undefined) presentation.serverUrl = value.serverUrl;
    return presentation;
  }
  if (value.kind === 'task') {
    const task = {
      kind: 'task',
      version: 1,
      installationId: value.installationId,
      taskId: value.taskId,
      title: value.title,
      status: value.status,
      cardLabel: value.cardLabel,
      stepCount: {
        done: value.stepCount.done,
        total: value.stepCount.total,
      },
    };
    if (value.summary !== undefined) task.summary = value.summary;
    if (value.pendingPrompt !== undefined) {
      if (value.pendingPrompt === null) {
        task.pendingPrompt = null;
      } else {
        const prompt = {
          kind: value.pendingPrompt.kind,
          botId: value.pendingPrompt.botId,
          text: value.pendingPrompt.text,
        };
        if (value.pendingPrompt.options !== undefined) {
          prompt.options = [...value.pendingPrompt.options];
        }
        task.pendingPrompt = prompt;
      }
    }
    if (value.stepsPreview !== undefined) {
      task.stepsPreview = value.stepsPreview.map((step) => {
        const preview = {
          id: step.id,
          text: step.text,
          status: step.status,
        };
        if (step.botName !== undefined) preview.botName = step.botName;
        return preview;
      });
    }
    return task;
  }
  const questionnaire = {
    kind: 'questionnaire',
    version: 1,
    installationId: value.installationId,
    conversationId: value.conversationId,
    requestId: value.requestId,
    status: value.status,
    questions: value.questions.map((question) => {
      const projected = {
        question: question.question,
        header: question.header,
        options: question.options.map((option) => {
          const projectedOption = { label: option.label, description: option.description };
          if (option.preview !== undefined) projectedOption.preview = option.preview;
          return projectedOption;
        }),
      };
      if (question.multiSelect !== undefined) projected.multiSelect = question.multiSelect;
      return projected;
    }),
  };
  if (value.result !== undefined) {
    const result = {
      answers: value.result.answers.map((answer) => {
        const projected = {
          questionIndex: answer.questionIndex,
          question: answer.question,
          kind: answer.kind,
          answer: answer.answer,
        };
        if (answer.selected !== undefined) projected.selected = [...answer.selected];
        if (answer.notes !== undefined) projected.notes = answer.notes;
        if (answer.preview !== undefined) projected.preview = answer.preview;
        return projected;
      }),
      cancelled: value.result.cancelled,
    };
    if (value.result.globalNote !== undefined) result.globalNote = value.result.globalNote;
    if (value.result.unanswered !== undefined) result.unanswered = [...value.result.unanswered];
    questionnaire.result = result;
  }
  return questionnaire;
}

/**
 * Extract the presentation a trusted tool published: the candidate is
 * slot.details (running calls) or the persisted toolResult message.details
 * (settled calls, including aborted/interrupted results built from the slot).
 * Returns the whitelist-rebuilt value, or null when no valid presentation
 * exists — unknown kinds, wrong versions, malformed fields and anything over
 * the 48 KiB whitelist budget are all dropped silently.
 */
export function projectToolPresentation(details) {
  const value = isPlainObject(details) ? details.presentation : undefined;
  let valid = true;
  const fail = () => {
    valid = false;
  };
  try {
    checkPresentation(value, fail);
    if (!valid) return null;
    const presentation = buildPresentation(value);
    if (toolPresentationBytes(presentation) > TOOL_PRESENTATION_MAX_BYTES) return null;
    return presentation;
  } catch {
    return null;
  }
}

/**
 * Strict wire validation for remote-live-protocol: throws INVALID_ARGUMENT on
 * any protocol violation (unknown fields, bad types, over-budget value). The
 * caller already verified the frame budget; this rejects malformed structure
 * so a forged host frame can never reach a client.
 */
export function normalizeToolPresentation(value) {
  const fail = (reason) => {
    throw messageError(INVALID_ARGUMENT, 'tool presentation ' + reason);
  };
  checkPresentation(value, fail);
  const presentation = buildPresentation(value);
  if (toolPresentationBytes(presentation) > TOOL_PRESENTATION_MAX_BYTES) {
    fail('exceeds 48 KiB');
  }
  return presentation;
}
