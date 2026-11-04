// Ported from @juicesharp/rpiv-ask-user-question 2.15.0 (MIT, see LICENSE):
// tool/validate-questionnaire.ts — pure runtime validation of question params.
import { MAX_QUESTIONS, MIN_OPTIONS, RESERVED_LABELS } from './schema.js';

export const ERROR_NO_QUESTIONS = 'Error: At least one question is required';
export const ERROR_TOO_MANY_QUESTIONS = `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation`;
export const ERROR_DUPLICATE_QUESTION = 'Error: Question text must be unique within an invocation';
export const ERROR_TOO_FEW_OPTIONS = `Error: Each question requires at least ${MIN_OPTIONS} options`;
export const ERROR_RESERVED_LABEL = `Error: Option label is reserved (${RESERVED_LABELS.join(', ')})`;
export const ERROR_DUPLICATE_OPTION_LABEL = 'Error: Option labels must be unique within a question';

const RESERVED_LABEL_SET = new Set(RESERVED_LABELS);

/**
 * Pure runtime validator for question params.
 * `reserved_label` MUST short-circuit before `duplicate_option_label`.
 */
export function validateQuestionnaire(typed) {
  if (typed.questions.length === 0) {
    return { ok: false, error: 'no_questions', message: ERROR_NO_QUESTIONS };
  }
  if (typed.questions.length > MAX_QUESTIONS) {
    return { ok: false, error: 'too_many_questions', message: ERROR_TOO_MANY_QUESTIONS };
  }

  const seenQuestions = new Set();
  for (const q of typed.questions) {
    if (seenQuestions.has(q.question)) {
      return { ok: false, error: 'duplicate_question', message: ERROR_DUPLICATE_QUESTION };
    }
    seenQuestions.add(q.question);
  }

  for (const q of typed.questions) {
    if (q.options.length < MIN_OPTIONS) {
      return { ok: false, error: 'empty_options', message: ERROR_TOO_FEW_OPTIONS };
    }
    const seenLabels = new Set();
    for (const o of q.options) {
      if (RESERVED_LABEL_SET.has(o.label)) {
        return { ok: false, error: 'reserved_label', message: ERROR_RESERVED_LABEL };
      }
      if (seenLabels.has(o.label)) {
        return { ok: false, error: 'duplicate_option_label', message: ERROR_DUPLICATE_OPTION_LABEL };
      }
      seenLabels.add(o.label);
    }
  }

  return { ok: true };
}
