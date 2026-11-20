// Where each Google account's checks left off (Gmail history point, each calendar's sync token), and
// since when each bot has listened on an account. No secrets.
// Adapted from upstream src/main/google/google-trigger-state.ts: pure schema and atomic file I/O
// without Electron user-data-path dependencies.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export const GoogleTriggerStateSchema = z.object({
  accounts: z
    .record(
      z.string(),
      z.object({
        historyId: z.string().optional(),
        calendars: z.record(z.string(), z.object({ syncToken: z.string().optional() })).optional()
      })
    )
    .default({}),
  /** `${botId} ${account}` to when that bot began listening there: older mail never starts it. */
  listeners: z.record(z.string(), z.number()).default({})
})

export type GoogleTriggerState = z.infer<typeof GoogleTriggerStateSchema>

export const listenerKey = (botId: string, account: string): string => `${botId} ${account}`

export function emptyGoogleTriggerState(): GoogleTriggerState {
  return { accounts: {}, listeners: {} }
}

export function parseGoogleTriggerState(raw: unknown): GoogleTriggerState {
  const parsed = GoogleTriggerStateSchema.safeParse(raw)
  return parsed.success ? parsed.data : emptyGoogleTriggerState()
}

export function readGoogleTriggerState(filePath: string): GoogleTriggerState {
  try {
    return parseGoogleTriggerState(JSON.parse(readFileSync(filePath, 'utf-8')))
  } catch {
    // Nothing saved yet, or unreadable: start from now.
    return emptyGoogleTriggerState()
  }
}

export function writeGoogleTriggerState(state: GoogleTriggerState, filePath: string): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const validated = GoogleTriggerStateSchema.parse(state)
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tempPath, `${JSON.stringify(validated)}\n`, { encoding: 'utf-8', mode: 0o600 })
    renameSync(tempPath, filePath)
  } catch (error) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // ignore cleanup error
    }
    throw error
  }
}
