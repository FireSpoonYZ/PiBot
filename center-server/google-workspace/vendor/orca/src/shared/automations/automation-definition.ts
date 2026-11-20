// Minimal type-only extract from upstream src/shared/automations/automation-definition.ts
// for vendored Google Workspace trigger matching.
import type { AutomationGoogleTrigger } from '../automation-google-triggers.ts'

export type Automation = {
  id: string
  enabled: boolean
  bot?: {
    botId: string
    runsIn?: string
    resultsTo?: string
  }
  on?: readonly (AutomationGoogleTrigger | { source: string; [key: string]: unknown })[]
}
