# Hermes learning — manage_bot_learning

`manage_bot_learning({deviceId, botId, action, ...})` drives the center learning service for exactly the target Bot. Learning runs the vendored upstream Hermes modules (background review / learn / curator) on the center; the target Bot's Host executes the actual model loop.

Actions: `status | configure | learn | review | curate | cancel`.

## What learning is

- A review/teach pass runs in a SEPARATE model context after a finalized successful user submission — it never blocks or mutates the foreground reply, and it never triggers another review (no recursion).
- One active job per Bot at a time. Automatic review follows the per-Bot configuration (enabled by default) with upstream-style bounded intervals; `learn`/`review`/`curate` are explicit manual runs and are recorded as such.
- Learning writes go through the managed skill service only — read-before-write is enforced and `locked` skills refuse them. Successful content edits are saved as drafts and publication is attempted; queued or failed publication is not a Host deployment. Learning never edits SOUL.
- Jobs are cancelled on Host disconnect/shutdown or when configuration disables learning; counters and job receipts survive restarts and interrupted work is marked interrupted, not success.

## Rules

- `configure` uses CAS: read the current settings via `status`, then submit changes with the returned `expectedRevision`/config revision.
- `learn {focus?}`, `review`, `curate` start a job and return an honest job receipt (`jobId`, `status`): `queued`/`running` is a live handle, NOT a finished result. Report the receipt, then check `status` for the outcome summary — never paraphrase a started job as learned.
- `cancel {jobId}` is bound to that job; cancellation is reported in the job state.
- Automatic reviews already cover normal traffic — run manual `learn`/`review` only when the user asks for a teaching pass or a focus area.

## Flows

Check: `manage_bot_learning {action:'status'}` → per-Bot enabled flag, interval/config, counters, active job, last results.

Configure: `status` → `configure` with the config revision + desired fields (enable/disable, interval bounds). A conflict means re-read.

Manual run: `learn {requestId, focus?}` (turn provided sources/notes into a reusable skill), `review` (skill review of recent work; memory tools are not enabled), or `curate` (skill maintenance: stale/archive/consolidate). All return `{jobId, status}`; poll `status` for completion/failure and the action summary.
