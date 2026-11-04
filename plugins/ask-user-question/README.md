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

- **Model tool** `ask_user_question` (`callers: ['model']`, `replay: 'safe'`):
  1-4 questions, 2-4 options each, `multiSelect` flag, optional per-option
  `preview`. Parameters, limits, reserved labels (`Other`,
  `Type something.`, `Next`), duplicate guards, normalization and the
  LLM-facing result text match upstream 2.15.0.
- **Capability action** `answerQuestionnaire`: submits or cancels one pending
  request. Input: `{conversationId, requestId, cancelled, answers[],
  globalNote?}` where `requestId` is the tool task id and each answer is
  `{questionIndex, selectedOptions?, customText?, notes?}`. Returns
  `{status: 'answered' | 'cancelled' | 'settled'}` — `settled` means the
  request was already terminal or its task expired, so the UI can refresh.

## State and lifecycle

Requests persist in the conversation-scoped Durable document
`e-launcher.ask-user-question` (`history: 'latest'`), keyed by
`String(toolTaskId)`; several requests may be pending at once. The tool waits
on `watchDoc` + the invocation abort signal — no polling, no persistent
Promise across restarts. First valid answer wins inside one atomic commit; an
answer can commit only while its tool task is still live, so a settled task can
never be answered — the final presentation is computed inside the same commit and oversized answers are rejected before anything is stored. Stop/abort leaves the record pending and ends the wait
without marking it user-cancelled; a restart replays the wait and picks up any
answer committed meanwhile. The tool's `details` always carries the
whitelisted `presentation` shape (`kind: 'questionnaire'`, `version: 1`)
bounded to 48 KiB; oversized calls are rejected at the tool boundary.

## Configuration

No settings (`config.schema.json` accepts an empty object), no credentials.

## Install

Pack this directory (`package.json`, `capability.json`,
`config.schema.json`, `entry.js`, `presentation.js`, `tool/*.js`,
`LICENSE`, this file) as a capability artifact, upload it through the Center
package flow, then enable `e-launcher.ask-user-question` for the Bot in the
capability settings. The UI answers through the existing
`callCapabilityAction` route with `action: 'answerQuestionnaire'`.
