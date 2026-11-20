// Minimal type-only extract from upstream src/shared/automation-event-triggers.ts
// for vendored Google Workspace triggers without pulling unrelated cloud connectors.
import type { AutomationGoogleTrigger, GoogleEventSource } from './automation-google-triggers.ts'

export type AutomationRunEvent = {
  triggerId: string
  source: GoogleEventSource | (string & {})
  event: AutomationGoogleTrigger['event'] | (string & {})
  /** The source's own id for the event; one run per key. */
  key: string
  /** The thread, PR or issue; later events on it fold into its unfinished run. */
  subject?: string
  occurredAt: number
  /** Display strings: who did it and where ("Dana Lee", "#infra"). */
  actor?: string
  actorId?: string
  fromOwner?: true
  place?: string
  url?: string
  text?: string
  /** A Gmail or Calendar event: the account it came on and Orca's ref for the mail or event. */
  google?: { account: string; ref: string }
}
