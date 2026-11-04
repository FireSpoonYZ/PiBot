// Ported from @juicesharp/rpiv-ask-user-question 2.15.0 (MIT, see LICENSE):
// tool/external-answer.ts — turn a raw answer payload into the
// QuestionnaireResult the dialog would have produced. Adapted to this host's
// answerQuestionnaire action vocabulary: cancelled / selectedOptions /
// customText / notes / globalNote, partial answers allowed.
import { MAX_ANSWER_TEXT_LENGTH } from './schema.js';
import { normalizeLineTerminators } from './normalize-params.js';

const reject = (code, reason) => ({ ok: false, code, reason });
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function textField(v, { allowBlank }) {
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: false, code: 'invalid_payload', reason: 'must be a string' };
  if (v.length > MAX_ANSWER_TEXT_LENGTH) {
    return { ok: false, code: 'invalid_payload', reason: `exceeds ${MAX_ANSWER_TEXT_LENGTH} characters` };
  }
  const normalized = normalizeLineTerminators(v);
  if (!allowBlank && normalized.trim().length === 0) {
    return { ok: false, code: 'invalid_answer', reason: 'text is blank' };
  }
  return { ok: true, value: normalized };
}

/** A note as the UI stores it: trimmed, and absent when blank. */
function noteOf(v) {
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve an answerQuestionnaire action input against the stored questions.
 * Questions, labels, and previews are read from the persisted request only —
 * client-supplied copies are never trusted. Answers must cover every question
 * unless cancelled; entry order is free. Returns { ok, result } or { ok:false }.
 */
export function resolveAnswers(questions, input) {
  const { answers, globalNote, cancelled } = input;
  const note = noteOf(globalNote);
  const withNote = note ? { globalNote: note } : {};

  if (cancelled === true) {
    if (!Array.isArray(answers) || answers.length !== 0) {
      return reject('invalid_payload', 'cancelled takes an empty answers array');
    }
    return { ok: true, result: { answers: [], cancelled: true, ...withNote } };
  }
  if (!Array.isArray(answers)) return reject('invalid_payload', 'answers must be an array');

  const byQuestion = new Map();
  for (const entry of answers) {
    if (!isRecord(entry)) return reject('invalid_payload', 'each answer must be an object');
    const index = entry.questionIndex;
    if (!Number.isInteger(index)) return reject('invalid_payload', 'questionIndex must be an integer');
    if (index < 0 || index >= questions.length) {
      return reject('invalid_answer', `questionIndex ${index} out of range (0..${questions.length - 1})`);
    }
    if (byQuestion.has(index)) return reject('invalid_answer', `question ${index} answered twice`);
    byQuestion.set(index, entry);
  }

  const resolved = [];
  for (let i = 0; i < questions.length; i++) {
    const entry = byQuestion.get(i);
    if (!entry) return reject('invalid_answer', `no answer for question ${i} ("${questions[i].header}")`);
    const answer = resolveEntry(questions[i], i, entry);
    if (!answer.ok) return answer;
    resolved.push(answer.answer);
  }
  return { ok: true, result: { answers: resolved, cancelled: false, ...withNote } };
}

function resolveEntry(q, i, entry) {
  const { selectedOptions, customText, notes } = entry;
  if (selectedOptions !== undefined && (!Array.isArray(selectedOptions) || !selectedOptions.every(Number.isInteger))) {
    return reject('invalid_payload', `question ${i}: selectedOptions must be an array of integers`);
  }
  const text = textField(customText, { allowBlank: false });
  if (!text.ok) return withQuestion(text, i);
  if (notes !== undefined && typeof notes !== 'string') {
    return reject('invalid_payload', `question ${i}: notes must be a string`);
  }
  if (notes !== undefined && notes.length > MAX_ANSWER_TEXT_LENGTH) {
    return reject('invalid_payload', `question ${i}: notes exceeds ${MAX_ANSWER_TEXT_LENGTH} characters`);
  }
  const note = noteOf(notes === undefined ? undefined : normalizeLineTerminators(notes));
  const withNote = note ? { notes: note } : {};

  const invalid = (reason) => ({ ok: false, code: 'invalid_answer', reason: `question ${i}: ${reason}` });
  const picked = selectedOptions ?? [];
  const out = picked.find((n) => n < 0 || n >= q.options.length);
  if (out !== undefined) return invalid(`option index ${out} out of range (0..${q.options.length - 1})`);
  if (new Set(picked).size !== picked.length) return invalid('option index repeated');
  if (picked.length === 0 && text.value === undefined) return invalid('needs selectedOptions or customText');

  const base = { questionIndex: i, question: q.question };

  if (q.multiSelect) {
    const selected = q.options.filter((_o, n) => picked.includes(n)).map((o) => o.label);
    return {
      ok: true,
      answer: { ...base, kind: 'multi', answer: text.value ?? null, selected, ...withNote },
    };
  }
  if (picked.length > 0 && text.value !== undefined) {
    return invalid('single-select takes selectedOptions or customText, not both');
  }
  if (picked.length > 1) return invalid(`single-select takes one option, got ${picked.length}`);
  if (text.value !== undefined) {
    return { ok: true, answer: { ...base, kind: 'custom', answer: text.value, ...withNote } };
  }
  const option = q.options[picked[0]];
  const withPreview = option.preview && option.preview.length > 0 ? { preview: option.preview } : {};
  return { ok: true, answer: { ...base, kind: 'option', answer: option.label, ...withPreview, ...withNote } };
}

function withQuestion(outcome, i) {
  return { ok: false, code: outcome.code, reason: `question ${i}: ${outcome.reason}` };
}
