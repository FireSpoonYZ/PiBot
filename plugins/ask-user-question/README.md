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

- **Model and nested tool** `ask_user_question` (`replay: 'safe'`; SDK-default callers `model` and `tools`):
  1-4 questions, 2-4 options each, `multiSelect` flag, optional per-option
  `preview`. Parameters, limits, reserved labels (`Other`,
  `Type something.`, `Next`), duplicate guards, normalization and the
  answer formatting match upstream 2.15.0. Direct standalone calls, multi-tool
  rounds, and nested/Code Mode calls all remain supported.
- **Capability action** `answerQuestionnaire`: submits or cancels one pending
  request. Input: `{conversationId, requestId, cancelled, answers[],
  globalNote?}` where `requestId` is the tool task id and each answer is
  `{questionIndex, selectedOptions?, customText?, notes?}`. Returns
  `{status: 'answered' | 'cancelled' | 'settled'}` — `settled` means the
  request was already settled or unavailable, so the UI can refresh.

## State and lifecycle

Version 1.1.0 uses the Host's session-scoped `host.durable-wait` documents
**only** when `ask_user_question` is invoked directly as the sole tool call in
a model response during an eligible unscoped, non-task-dispatch primary turn
(without `workNativeId`), where `control.terminate` can safely release the SDK
run so the Bot can handle other inputs while waiting.

For nested/Code Mode calls, multi-tool rounds, scoped DM/room turns, task
dispatches, turns with `workNativeId`, and pre-existing live-task (`open`)
requests, the plugin falls back to the task-scoped `e-launcher.ask-user-question`
live-task protocol. That fallback waits in-band within the running tool task
and does not pause or independently release the Bot.

For persisted primary waits, the Host verifies the stored wait identity before
making its card interactive; a completed tool task does not expire this
external wait. The first valid answer commits atomically with immutable
continuation text. The Host reconciles the existing TurnQueue receipt and
submits the same request ID only when it is definitively absent. Stop, clear
history, edit/fork, archive and deletion cancel the corresponding waits and
continuation handoffs. Any pre-existing experimental wait record outside
deployed eligibility is safely closed/cancelled offline without re-admitting.
User cancellation is delivered as a refusal; a Host stop does not restart work.
Presentations remain limited to 48 KiB, including answers.

Existing in-flight live-task (`open`) and deferred (`deferred`) replays remain
coherent and idempotent across restarts. See
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
