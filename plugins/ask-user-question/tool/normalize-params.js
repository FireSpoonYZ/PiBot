// Ported from @juicesharp/rpiv-ask-user-question 2.15.0 (MIT, see LICENSE):
// tool/normalize-params.ts — line-terminator normalization and prepareArguments.

/**
 * Normalize line terminators in one model-supplied text field.
 * `\r\n` → `\n`; a lone `\r` is deleted — never a space and never `\n`.
 */
export function normalizeLineTerminators(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

function normalizeStringFields(obj, keys) {
  const out = { ...obj };
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') out[key] = normalizeLineTerminators(value);
  }
  return out;
}

/**
 * Copy the tool params with every user-facing string field
 * (`question`, `header`, `options[].label`, `options[].description`,
 * `options[].preview`) line-terminator-normalized, BEFORE validation, so the
 * reserved-label and duplicate guards compare the text the user actually sees.
 */
export function normalizeQuestionParams(params) {
  return {
    ...params,
    questions: (params.questions ?? []).map((q) => ({
      ...normalizeStringFields(q, ['question', 'header']),
      options: (q.options ?? []).map((o) => normalizeStringFields(o, ['label', 'description', 'preview'])),
    })),
  };
}

/**
 * Undo double-encoded tool arguments before schema validation: only a string at
 * an array/object position is decoded, and only when it parses to the expected
 * shape; anything else passes through so validation reports the real problem.
 */
export function prepareQuestionArguments(args) {
  if (!isRecord(args)) return args;
  const questions = decodeArray(args.questions);
  if (!Array.isArray(questions)) return args;
  const decoded = questions.map((q) => {
    const question = decodeObject(q);
    if (!isRecord(question)) return question;
    const options = decodeArray(question.options);
    return Array.isArray(options) ? { ...question, options: options.map(decodeObject) } : question;
  });
  return { ...args, questions: decoded };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeArray(value) {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  return Array.isArray(parsed) ? parsed : value;
}

function decodeObject(value) {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  return isRecord(parsed) ? parsed : value;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
