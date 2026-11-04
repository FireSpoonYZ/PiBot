// Ported from @juicesharp/rpiv-ask-user-question 2.15.0 (MIT, see LICENSE):
// tool/types.ts — question/answer shapes, limits, and the parameter schema.
// Written as plain JSON Schema: the engine's Type builder is a peer dependency
// unavailable inside the installed package root (npm ci --omit=peer), and the
// ToolRegistration accepts either a TSchema or a plain JSON Schema object.
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;
// Display-lane text budgets shared with the projection whitelist.
export const MAX_QUESTION_LENGTH = 600;
export const MAX_DESCRIPTION_LENGTH = 600;
export const MAX_PREVIEW_LENGTH = 4000;
// Per-field bound on user-authored answer text (customText, notes, globalNote);
// mirrors the action inputSchema caps in capability.json.
export const MAX_ANSWER_TEXT_LENGTH = 2000;

// Upstream reserved labels ("Other", "Type something.", "Next"); the runtime
// sentinel rows do not exist in this host, but reservation stays unconditional.
export const RESERVED_LABELS = ['Other', 'Type something.', 'Next'];

export const OptionSchema = {
  type: 'object',
  properties: {
    label: {
      type: 'string',
      maxLength: MAX_LABEL_LENGTH,
      description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.`,
    },
    description: {
      type: 'string',
      maxLength: MAX_DESCRIPTION_LENGTH,
      description:
        'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
    },
    preview: {
      type: 'string',
      maxLength: MAX_PREVIEW_LENGTH,
      description:
        'Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.',
    },
  },
  required: ['label', 'description'],
  additionalProperties: false,
};

export const QuestionSchema = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      maxLength: MAX_QUESTION_LENGTH,
      description:
        'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
    },
    header: {
      type: 'string',
      maxLength: MAX_HEADER_LENGTH,
      description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".`,
    },
    options: {
      type: 'array',
      items: OptionSchema,
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      description:
        "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.",
    },
    multiSelect: {
      type: 'boolean',
      description:
        'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
    },
  },
  required: ['question', 'header', 'options'],
  additionalProperties: false,
};

export const QuestionParamsSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: QuestionSchema,
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      description: 'Questions to ask the user (1-4 questions)',
    },
  },
  required: ['questions'],
  additionalProperties: false,
};
