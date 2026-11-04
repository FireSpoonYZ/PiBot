// QuestionnairePresentation — the single UI contract shared by live details
// (running tool) and final details (tool result). The live projection
// whitelists this shape; do not add unknown fields without extending it there.

/** Per-presentation serialized byte budget (UTF-8). */
export const PRESENTATION_MAX_BYTES = 48 * 1024;

function questionsForPresentation(questions) {
  return questions.map((q) => ({
    question: q.question,
    header: q.header,
    ...(q.multiSelect === true ? { multiSelect: true } : {}),
    options: q.options.map((o) => ({
      label: o.label,
      description: o.description,
      ...(typeof o.preview === 'string' && o.preview.length > 0 ? { preview: o.preview } : {}),
    })),
  }));
}

/**
 * Build the details object of one request: { presentation, questions }.
 * Returns null when the serialized presentation exceeds the byte budget —
 * the caller rejects the tool call rather than shipping a truncated card.
 */
export function requestDetails(installationId, conversationId, requestId, questions, result) {
  const settled = result !== undefined;
  const presentation = {
    kind: 'questionnaire',
    version: 1,
    installationId,
    conversationId,
    requestId,
    status: settled ? (result.cancelled === true ? 'cancelled' : 'answered') : 'pending',
    questions: questionsForPresentation(questions),
    ...(settled
      ? {
          result: {
            answers: result.answers ?? [],
            cancelled: result.cancelled === true,
            ...(result.globalNote ? { globalNote: result.globalNote } : {}),
            ...(Array.isArray(result.unanswered) && result.unanswered.length > 0
              ? { unanswered: result.unanswered }
              : {}),
          },
        }
      : {}),
  };
  const details = { presentation, questions: questionsForPresentation(questions) };
  return fitsBudget(details) ? details : null;
}

/** 序列化 presentation 的 UTF-8 字节数；不可序列化返回 Infinity。 */
export function presentationBytes(details) {
  try {
    return Buffer.byteLength(JSON.stringify(details?.presentation), 'utf8');
  } catch {
    return Infinity;
  }
}

function fitsBudget(details) {
  return presentationBytes(details) <= PRESENTATION_MAX_BYTES;
}

/** Terminal-state details: same envelope, status/result updated in place. */
export function settledDetails(details, status, result) {
  if (status === 'settled') return details;
  return {
    ...details,
    presentation: {
      ...details.presentation,
      status,
      result: {
        answers: result?.answers ?? [],
        cancelled: result?.cancelled === true,
        ...(result?.globalNote ? { globalNote: result.globalNote } : {}),
        ...(Array.isArray(result?.unanswered) && result.unanswered.length > 0
          ? { unanswered: result.unanswered }
          : {}),
      },
    },
  };
}
