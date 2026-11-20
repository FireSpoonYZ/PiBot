// Adapted from upstream src/shared/rpc-contract/google-call-params.ts &
// rpc-param-primitives.ts (OptionalString) without pulling browser target validators.
import * as z from 'zod'

const OptionalString = z
  .unknown()
  .transform((value) => (typeof value === 'string' && value.length > 0 ? value : undefined))
  .pipe(z.union([z.string(), z.undefined()]))
  .optional()

/** Every Google tool call: the bot run's token (a bot's Google may be off), the chat it runs from for
 *  attribution, and which account. */
export const GoogleCallParams = {
  botToken: OptionalString,
  callerSessionId: OptionalString,
  account: z.string().trim().toLowerCase().email().max(320).optional()
}

/** A Google id, ref or link, as a command takes it. */
export const GoogleRef = z.string().trim().min(1).max(2_048)
