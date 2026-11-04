// Ported from @juicesharp/rpiv-ask-user-question 2.15.0 (MIT, see LICENSE):
// tool/response-envelope.ts — LLM-facing result text and details envelope.
import { formatAnswerScalar } from './format-answer.js';

export const DECLINE_MESSAGE = 'User declined to answer questions';
export const ENVELOPE_PREFIX = 'User has answered your questions:';
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

/**
 * Map a QuestionnaireResult (or null/cancelled) to the LLM-facing tool result.
 * Cancelled and "no segments" both fall to DECLINE_MESSAGE; a partial submit
 * names the blank questions in an `unanswered:` segment and details.unanswered.
 */
export function buildQuestionnaireResponse(result, params) {
  if (!result || result.cancelled) {
    return buildToolResult(DECLINE_MESSAGE, {
      answers: result?.answers ?? [],
      cancelled: true,
      ...(result?.globalNote && result.globalNote.length > 0 ? { globalNote: result.globalNote } : {}),
    });
  }
  const segments = [];
  const unanswered = [];
  for (let i = 0; i < params.questions.length; i++) {
    const a = result.answers.find((x) => x.questionIndex === i);
    if (a) segments.push(buildAnswerSegment(a));
    else unanswered.push(i);
  }
  const hasGlobalNote = result.globalNote !== undefined && result.globalNote.length > 0;
  if (segments.length === 0 && !hasGlobalNote) {
    return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
  }
  if (unanswered.length > 0) segments.push(buildUnansweredSegment(unanswered, params));
  if (hasGlobalNote) segments.push(`global note: ${result.globalNote}.`);
  const details = unanswered.length > 0 ? { ...result, unanswered } : result;
  return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(' ')} ${ENVELOPE_SUFFIX}`, details);
}

/** `unanswered: "<question>", "<question>".` — the questions left blank on a partial submit. */
export function buildUnansweredSegment(indexes, params) {
  return `unanswered: ${indexes.map((i) => `"${params.questions[i]?.question}"`).join(', ')}.`;
}

/** Format a single answer segment: `"Q"="A"` plus optional preview/notes suffixes. */
export function buildAnswerSegment(a) {
  const parts = [`"${a.question}"="${formatAnswerScalar(a)}"`];
  if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
  if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
  return `${parts.join('. ')}.`;
}

export function buildToolResult(text, details) {
  return {
    output: [{ type: 'text', text }],
    details,
  };
}
