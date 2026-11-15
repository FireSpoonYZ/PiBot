# e-launcher.ask-user-question

Native Host capability port of **@juicesharp/rpiv-ask-user-question 2.15.0**
(upstream: https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question,
MIT — see `LICENSE`). The pure questionnaire core (schema, line-terminator
normalization, validation, answer resolution, result envelope) is ported under
`tool/` with upstream logic and limits preserved; all pi-tui/TUI view code,
events, i18n, config-file loading and the RPC dialog walker are intentionally
not ported — this host presents the questionnaire over the capability-action
protocol instead.

## What it registers

- **Direct model tool** `ask_user_question` (`replay: 'safe'`):
  1-4 questions, 2-4 options each, `multiSelect` flag, optional per-option
  `preview`. Parameters, limits, reserved labels (`Other`,
  `Type something.`, `Next`), duplicate guards, normalization and the
  answer formatting match upstream 2.15.0. New questionnaires must be the only
  tool call in a model response. The Host keeps this direct tool available in
  Code Mode-only mode; new nested calls and multi-tool rounds return an error
  without publishing a questionnaire.
- **Capability action** `answerQuestionnaire`: submits or cancels one pending
  request. Input: `{conversationId, requestId, cancelled, answers[],
  globalNote?}` where `requestId` is the tool task id and each answer is
  `{questionIndex, selectedOptions?, customText?, notes?}`. Returns
  `{status: 'answered' | 'cancelled' | 'settled'}` — `settled` means the
  request was already settled or unavailable, so the UI can refresh.

## State and lifecycle

Version 1.1.0 uses the Host's session-scoped `host.durable-wait` documents.
Publishing a request ends the current SDK run with `control.terminate`, so the
same Bot can handle other inputs while the questionnaire is pending. The
single-tool-round restriction is required by the pinned SDK's termination
semantics. The Host verifies the stored wait identity before making its card
interactive; a completed tool task does not expire this external wait.

The first valid answer commits atomically with immutable continuation text.
The Host reconciles the existing TurnQueue receipt and submits the same request
ID only when it is definitively absent. The original stop epoch, task dispatch
context and reply destination survive restart. Stop, scope Stop, clear history,
archive and deletion cancel the corresponding waits and continuation handoffs.
User cancellation is delivered as a refusal; a Host stop does not restart work.
Presentations remain limited to 48 KiB, including answers.

Existing `e-launcher.ask-user-question` task-scoped requests retain their old
watch-and-answer protocol. A Bot with a live legacy nested questionnaire keeps
that caller temporarily for recovery; new nested requests are still rejected.
Deploy the matching Host, Center and clients together. See
[architecture and migration](../../docs/always-on-runtime.md) and
[verification](../../docs/always-on-runtime-validation.md) before rollback.

## Configuration

No settings (`config.schema.json` accepts an empty object), no credentials.

## Install

Pack this directory (`package.json`, `capability.json`,
`config.schema.json`, `entry.js`, `presentation.js`, `tool/*.js`,
`LICENSE`, this file) as a capability artifact, upload it through the Center
package flow, then enable `e-launcher.ask-user-question` for the Bot in the
capability settings. The UI answers through the existing
`callCapabilityAction` route with `action: 'answerQuestionnaire'`.
