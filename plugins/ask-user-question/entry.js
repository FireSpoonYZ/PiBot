// e-launcher.ask-user-question — native Host plugin port of
// @juicesharp/rpiv-ask-user-question 2.15.0 (MIT, see LICENSE). The model calls
// ask_user_question; the questions persist in a task-scoped Durable document
// and wait for the answerQuestionnaire capability action. Pending requests
// survive process restarts and are answered by the same action; answers commit
// only while their tool task is still live, so a settled task can never be
// answered. Task-scoped docs retire with the task — terminal records never
// linger, and history forks never clone a pending questionnaire.
import { prepareQuestionArguments, normalizeQuestionParams, normalizeLineTerminators } from './tool/normalize-params.js';
import { validateQuestionnaire } from './tool/validate-questionnaire.js';
import { buildQuestionnaireResponse, buildToolResult, DECLINE_MESSAGE } from './tool/response-envelope.js';
import { resolveAnswers } from './tool/resolve-answer.js';
import { QuestionParamsSchema, MAX_QUESTIONS, MAX_OPTIONS, MAX_ANSWER_TEXT_LENGTH } from './tool/schema.js';
import { requestDetails, settledDetails, presentationBytes, PRESENTATION_MAX_BYTES } from './presentation.js';

export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';

const DOC_KIND = 'e-launcher.ask-user-question';
const TOOL_TASK_KIND = 'pi.tool';

// initial() runs only for a fresh incarnation; execute() immediately
// overwrites it with the real params/details before waiting, so a record
// that still carries these defaults is treated as absent.
function initialState() {
  return {
    version: 1,
    status: 'settled',
    params: { questions: [] },
    details: { presentation: { kind: 'questionnaire', version: 1 }, questions: [] },
  };
}

const ACTION_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    conversationId: { type: 'integer', minimum: 1 },
    requestId: { type: 'string', minLength: 1, maxLength: 64 },
    cancelled: { type: 'boolean' },
    answers: {
      type: 'array',
      maxItems: MAX_QUESTIONS,
      items: {
        type: 'object',
        properties: {
          questionIndex: { type: 'integer', minimum: 0, maximum: MAX_QUESTIONS - 1 },
          selectedOptions: {
            type: 'array',
            maxItems: MAX_OPTIONS,
            items: { type: 'integer', minimum: 0, maximum: MAX_OPTIONS - 1 },
          },
          customText: { type: 'string', maxLength: MAX_ANSWER_TEXT_LENGTH },
          notes: { type: 'string', maxLength: MAX_ANSWER_TEXT_LENGTH },
        },
        required: ['questionIndex'],
        additionalProperties: false,
      },
    },
    globalNote: { type: 'string', maxLength: MAX_ANSWER_TEXT_LENGTH },
  },
  required: ['conversationId', 'requestId', 'cancelled', 'answers'],
  additionalProperties: false,
};

const DEFAULT_TOOL_DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or cancel the questionnaire entirely. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown. Multi-line text with newlines is supported. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

export function createPlugin({ installationId, host }) {
  const bots = new Set();
  // One task-scoped document per questionnaire, keyed by the tool task id:
  // the record lives and dies with its task, so a terminal request retires
  // with it instead of lingering, and a history fork never clones a pending
  // questionnaire into the new conversation.
  const Request = host.sdk.defineDoc({
    kind: DOC_KIND,
    version: 1,
    scope: 'task',
    initial: initialState,
  });

  return {
    async forBot({ botId }) {
      // Combined release: the tool task's own abort (user stop) plus this
      // bot's quiesce/close — pending records stay pending either way.
      const botController = new AbortController();
      let closed = false;
      const check = () => {
        if (closed) throw Object.assign(new Error('ask-user-question is not active.'), { code: 'EXTENSION_DISABLED' });
        host.assertCapabilityAllowed(botId, installationId);
      };

      /** AbortError honouring this platform's DOMException availability. */
      function abortError(reason) {
        if (reason instanceof Error) return reason;
        if (typeof DOMException === 'function') return new DOMException('The operation was aborted', 'AbortError');
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        return error;
      }

      function isLiveTask(task, conversationId) {
        return task !== undefined &&
          task.kind === TOOL_TASK_KIND &&
          task.conversationId === conversationId &&
          task.abortRequested !== true &&
          task.state.status !== 'completing' &&
          task.state.status !== 'terminal';
      }

      // details 里的持久记录身份必须正对本请求的实例与会话：防串会话
      // details 把过期/他处记录错投到本卡片。
      function detailsMatchesRequest(details, conversationId, requestId) {
        const p = details?.presentation;
        return p?.kind === 'questionnaire' &&
          p.installationId === installationId &&
          p.conversationId === conversationId &&
          p.requestId === requestId;
      }

      function createAskTool() {
        return host.sdk.defineTool({
          name: ASK_USER_QUESTION_TOOL_NAME,
          description: DEFAULT_TOOL_DESCRIPTION,
          parameters: QuestionParamsSchema,
          callers: ['model'],
          replay: 'safe',
          prepareArguments: prepareQuestionArguments,
          async execute(args, api, context) {
            context.abortSignal?.throwIfAborted();
            const requestId = String(api.taskId);
            const conversationId = api.conversationId;
            check();

            // Replay-safe: normalize+validate run before the phase check so
            // invalid arguments fail fast even on a replay. The pending
            // request record then commits exactly once, guarded by the phase
            // memo; a resumed execution skips re-publishing and only replays
            // the wait, keeping any answer committed in between.
            const typed = normalizeQuestionParams(args);
            const validation = validateQuestionnaire(typed);
            if (!validation.ok) {
              return buildToolResult(validation.message, {
                answers: [], cancelled: true, error: validation.error,
              });
            }
            const phase = await api.memo('ask-user-question.phase', context);
            let params;
            if (phase !== 'open') {
              const details = requestDetails(installationId, conversationId, requestId, typed.questions);
              if (details === null) {
                return buildToolResult(
                  'Error: questionnaire exceeds the presentation size budget',
                  { answers: [], cancelled: true, error: 'invalid_params' },
                );
              }
              params = typed;
              try {
                await api.commit(async (tx) => {
                  if (!isLiveTask(await tx.task(api.taskId), conversationId)) return;
                  const doc = await tx.doc(Request, api.taskId);
                  // ??= keeps a record a previous attempt committed — including
                  // an answer that landed before an interruption.
                  if (doc.status === 'settled') {
                    doc.status = 'pending';
                    doc.params = params;
                    doc.details = details;
                  }
                }, context);
                await api.memo('ask-user-question.phase', 'open', context);
              } catch (err) {
                if (!context.abortSignal?.aborted) throw err;
                // Aborted mid-commit: the record may or may not have landed;
                // either way the wait resumes it or finds none.
              }
            }

            // Open the watch only after the commit: the acquisition revision
            // in watch.value already carries an answer that landed during a
            // resume.
            let watch;
            try {
              watch = await api.watchDoc(Request, api.taskId, context);
            } catch (err) {
              // The record may be pending without a waiter; leave it —
              // a resume finds it again rather than marking it cancelled.
              throw err;
            }
            const initial = watch.value;
            if (initial !== null && initial.status !== 'pending') {
              // Already answered while this execution was interrupted.
              await watch.stop();
              return answeredResult(initial);
            }
            // Publish the pending questionnaire so the UI sees it while the
            // tool keeps running; the final details replace it at settle.
            const persisted = initial?.details;
            const pendingDetails = detailsMatchesRequest(persisted, conversationId, requestId)
              ? persisted
              : params !== undefined
                ? requestDetails(installationId, conversationId, requestId, params.questions)
                : undefined;
            if (pendingDetails !== undefined && pendingDetails !== null) {
              // 不吞错：待答卡片发布失败必须让本次执行失败，不能静默跑出一个
              // UI 看不见的待答问卷。
              await api.details(pendingDetails, context);
            }

            let record;
            try {
              record = await waitFor(watch, context);
            } finally {
              await watch.stop();
            }
            return answeredResult(record);
          },
        });
      }

      /**
       * Wait for the record to leave 'pending'. Releases on whichever comes
       * first: a terminal record from the commit listener, the tool task's
       * abort (user stop), the bot's quiesce/close, or the watch's own end
       * when the Session closes — no wait can block a shutdown.
       * session_closed/session_failed reject, never masquerade as a user
       * decline; only a real cancelled record maps to DECLINE_MESSAGE.
       */
      function waitFor(watchHandle, context) {
        return new Promise((resolve, reject) => {
          let settled = false;
          const settle = (fn, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
          };
          const cleanup = () => {
            context.abortSignal?.removeEventListener('abort', onAbort);
            botController.signal.removeEventListener('abort', onAbort);
          };
          const onAbort = () => settle(reject, abortError(
            context.abortSignal?.aborted ? context.abortSignal.reason : botController.signal.reason,
          ));
          const unwatch = (end) => {
            if (end.reason === 'stopped') return;
            if (end.reason === 'failed') {
              settle(reject, end.error instanceof Error ? end.error : abortError(end.error));
            } else {
              // session_closed / retired / cancelled: interrupt, not a decline.
              settle(reject, abortError(end.reason));
            }
          };
          const current = watchHandle.value;
          // A fresh initial() placeholder or a still-'settled' record (never
          // opened): treat as no live questionnaire rather than wait forever.
          if (current === null || current.status !== 'pending') {
            settle(resolve, current);
            return;
          }
          watchHandle.closed.then(unwatch, (error) => settle(reject, error instanceof Error ? error : abortError(error)));
          if (context.abortSignal?.aborted || botController.signal.aborted) {
            onAbort();
            return;
          }
          context.abortSignal?.addEventListener('abort', onAbort, { once: true });
          botController.signal.addEventListener('abort', onAbort, { once: true });
          watchHandle.start(async (value) => {
            if (value === null || value.status !== 'pending') settle(resolve, value);
          });
        });
      }

      /** Build the tool result once the record is terminal. */
      function answeredResult(record) {
        const params = record?.params;
        if (record === null || record === undefined || params === undefined) {
          return { isError: true, output: [{ type: 'text', text: 'Error: questionnaire was interrupted before it could be answered' }] };
        }
        if (record.status === 'settled') {
          // The task was already terminal when an answer was attempted — the
          // user never saw a settled answer; report an interruption, not a decline.
          return {
            isError: true,
            output: [{ type: 'text', text: 'Error: questionnaire was interrupted before it could be answered' }],
            details: record.details,
          };
        }
        const result = record.status === 'answered' ? record.result : { answers: [], cancelled: true };
        const response = buildQuestionnaireResponse(result, params);
        // action 在事务里先算好的终态 details 直接复用（提交前已核 48KiB，
        // 保证投影不丢）；旧版本记录或仍是 pending 的 details 退化到本地合成。
        const stored = record.details?.presentation;
        const details = stored?.kind === 'questionnaire' && stored.status === record.status && stored.result !== undefined
          ? record.details
          : settledDetails(record.details, record.status, result);
        return { output: response.output, details };
      }

      async function answerQuestionnaire(input, invocationContext) {
        check();
        invocationContext.abortSignal?.throwIfAborted();
        const taskId = Number(input.requestId);
        if (!Number.isSafeInteger(taskId) || taskId < 1) return { status: 'settled' };
        const globalNote = input.globalNote === undefined
          ? undefined
          : normalizeLineTerminators(input.globalNote).trim() || undefined;

        // Ownership: the addressed conversation must belong to this Bot before
        // any durable write is attempted.
        if (await host.resolveConversationBot(input.conversationId) !== botId) {
          throw Object.assign(new Error('Conversation does not belong to this Bot.'), { code: 'BOT_CONTEXT_REQUIRED' });
        }

        const committed = await host.getHarness().commit(async (tx) => {
          // Expired-answer guard: the request may only settle while its tool
          // task is still live — a settled task can never be asked again.
          if (!isLiveTask(await tx.task(taskId), input.conversationId)) {
            return { status: 'settled' };
          }
          const doc = await tx.doc(Request, taskId);
          if (doc.status !== 'pending') return { status: 'settled' };
          // Questions, labels and previews come from the persisted request,
          // never from the client payload.
          const resolved = resolveAnswers(doc.params.questions, {
            cancelled: input.cancelled,
            answers: input.answers,
            globalNote,
          });
          if (!resolved.ok) {
            throw Object.assign(new Error(resolved.reason), { code: 'VALIDATION_FAILED' });
          }
          // 先算终态 details 并核 48KiB，再提交：超限回答不会被存了答案后
          // 又在投影中静默丢卡片。
          const finalDetails = requestDetails(
            installationId,
            input.conversationId,
            input.requestId,
            doc.params.questions,
            resolved.result,
          );
          if (finalDetails === null || presentationBytes(finalDetails) > PRESENTATION_MAX_BYTES) {
            throw Object.assign(new Error('Answered questionnaire exceeds the presentation size budget'), { code: 'VALIDATION_FAILED' });
          }
          // First valid answer wins — the atomic commit is the race gate.
          doc.status = resolved.result.cancelled ? 'cancelled' : 'answered';
          doc.result = resolved.result;
          doc.details = finalDetails;
          return { status: doc.status };
        }, invocationContext);
        check();
        return committed;
      }

      const bot = {
        durableContributions: {
          tools: [createAskTool()],
        },
        actions: {
          answerQuestionnaire: {
            inputSchema: ACTION_INPUT_SCHEMA,
            async execute(input, invocationContext) {
              return answerQuestionnaire(input, invocationContext);
            },
          },
        },
        async prepare() {},
        async activate() { check(); },
        // Release every waiter without marking pending requests cancelled:
        // the bot-level AbortController ends each waitFor, the pending records
        // stay pending, and a later execution resumes them.
        async quiesce() {
          closed = true;
          if (!botController.signal.aborted) {
            botController.abort(Object.assign(new Error('capability quiesced'), { code: 'EXTENSION_DISABLED' }));
          }
        },
        async close() {
          await bot.quiesce();
          bots.delete(bot);
        },
      };
      bots.add(bot);
      return bot;
    },
    async close() { await Promise.all([...bots].map((bot) => bot.close())); },
  };
}
