// Ported from @juicesharp/rpiv-ask-user-question 2.15.0 (MIT, see LICENSE):
// tool/format-answer.ts — scalar answer formatting.

/** Placeholder for empty / null answer text. */
export const NO_INPUT_PLACEHOLDER = '(no input)';

/** Format a QuestionAnswer to its scalar string form. */
export function formatAnswerScalar(a) {
  switch (a.kind) {
    case 'multi': {
      const values = [...(a.selected ?? [])];
      if (a.answer && a.answer.length > 0) values.push(a.answer);
      return values.length > 0 ? values.join(', ') : NO_INPUT_PLACEHOLDER;
    }
    case 'custom':
      return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
    case 'option':
      return a.answer ?? NO_INPUT_PLACEHOLDER;
    default:
      return NO_INPUT_PLACEHOLDER;
  }
}
