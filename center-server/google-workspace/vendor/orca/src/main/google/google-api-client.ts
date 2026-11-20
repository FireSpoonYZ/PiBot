// Calls Google's APIs as one connected account: validates fixed Google API origins and paths,
// refuses redirects so Bearer tokens never leak off-origin, keeps tokens fresh (retrying once on
// explicit HTTP 401, never retrying timed-out writes), caps downloaded bytes, and turns Google's
// errors into one sentence that says what to do.
//
// Adapted from upstream src/main/google/google-api-client.ts for Center-hosted accounts:
// replaces Electron host-local credential/token lookups with `createWorkspaceApi({ email,
// projectId, getAccessToken, fetchImpl })` while preserving `GoogleToolError`, `parseGoogleJson`,
// `GoogleWrite`, `GoogleApi`, and `failureSentence`.
import type { z } from 'zod'
import { googleApiEnableUrl, type GoogleService } from '../../shared/google/google-scopes.ts'
import { formatMegabytes, TOOL_DOWNLOAD_MAX_BYTES } from '../../shared/tool-output-limits.ts'
import { classifyGoogleApiError, readGoogleApiError } from './google-readiness.ts'

const REQUEST_TIMEOUT_MS = 20_000
const WRITE_METHODS = new Set<GoogleWrite['method']>(['POST', 'PATCH', 'PUT', 'DELETE'])

type ServiceUrlRule = {
  readonly origin: string
  readonly pathPrefixes: readonly string[]
}

const SERVICE_URL_RULES: Record<GoogleService, ServiceUrlRule> = Object.freeze({
  gmail: Object.freeze({
    origin: 'https://gmail.googleapis.com',
    pathPrefixes: Object.freeze(['/gmail/', '/upload/gmail/'])
  }),
  calendar: Object.freeze({
    origin: 'https://www.googleapis.com',
    pathPrefixes: Object.freeze(['/calendar/'])
  }),
  drive: Object.freeze({
    origin: 'https://www.googleapis.com',
    pathPrefixes: Object.freeze(['/drive/', '/upload/drive/'])
  }),
  docs: Object.freeze({
    origin: 'https://docs.googleapis.com',
    pathPrefixes: Object.freeze(['/v1/documents'])
  }),
  sheets: Object.freeze({
    origin: 'https://sheets.googleapis.com',
    pathPrefixes: Object.freeze(['/v4/spreadsheets'])
  }),
  contacts: Object.freeze({
    origin: 'https://people.googleapis.com',
    pathPrefixes: Object.freeze(['/v1/'])
  })
})

export const SERVICE_ALLOWED_ORIGINS: Readonly<Record<GoogleService, string>> = Object.freeze({
  gmail: SERVICE_URL_RULES.gmail.origin,
  calendar: SERVICE_URL_RULES.calendar.origin,
  drive: SERVICE_URL_RULES.drive.origin,
  docs: SERVICE_URL_RULES.docs.origin,
  sheets: SERVICE_URL_RULES.sheets.origin,
  contacts: SERVICE_URL_RULES.contacts.origin
})

export const ALLOWED_GOOGLE_API_ORIGINS: ReadonlySet<string> = new Set(
  Object.values(SERVICE_ALLOWED_ORIGINS)
)

export class GoogleToolError extends Error {
  /** Google's HTTP status, when Google answered; a checker backs off on 429. */
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GoogleToolError'
    if (status !== undefined) {
      this.status = status
    }
  }
}

/**
 * Validates that `rawUrl` targets the fixed HTTPS origin and path prefix allowed for `service`,
 * with no embedded credentials or non-default port. Fails closed before any token is fetched.
 */
export function assertAllowedGoogleApiUrl(service: GoogleService, rawUrl: string): URL {
  const rule = SERVICE_URL_RULES[service]
  if (!rule) {
    throw new GoogleToolError(`Unsupported Google service: ${String(service)}.`)
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new GoogleToolError('Refused malformed Google API URL.')
  }
  if (parsed.protocol !== 'https:') {
    throw new GoogleToolError(`Refused non-HTTPS Google API URL (${parsed.protocol}).`)
  }
  if (parsed.username || parsed.password) {
    throw new GoogleToolError('Refused Google API URL with embedded credentials.')
  }
  if (parsed.port !== '') {
    throw new GoogleToolError('Refused Google API URL with explicit port.')
  }
  if (!ALLOWED_GOOGLE_API_ORIGINS.has(parsed.origin) || parsed.origin !== rule.origin) {
    throw new GoogleToolError(`Refused disallowed Google API origin for ${service}: ${parsed.origin}.`)
  }
  if (!rule.pathPrefixes.some((prefix) => parsed.pathname.startsWith(prefix))) {
    throw new GoogleToolError(`Refused disallowed Google API path for ${service}: ${parsed.pathname}.`)
  }
  return parsed
}

/** A body read with a schema: the value, or null when Google answered in another shape. */
export const parseGoogleJson =
  <T>(schema: z.ZodType<T>) =>
  (body: unknown): T | null =>
    schema.safeParse(body).data ?? null

function parseBody(text: string): unknown {
  if (!text) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return null
  }
}

/** A write: JSON (the usual), or raw bytes such as an upload or a MIME message. */
export type GoogleWrite = {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  json?: unknown
  raw?: { body: Uint8Array<ArrayBuffer> | string; contentType: string }
}

export type GoogleApi = {
  /** The account's address, for output that says whose mail or calendar it is. */
  email: string
  get: <T>(service: GoogleService, url: string, read: (body: unknown) => T | null) => Promise<T>
  /** Like get, but null when Google says the thing doesn't exist (404). */
  find: <T>(
    service: GoogleService,
    url: string,
    read: (body: unknown) => T | null
  ) => Promise<T | null>
  /** A write; `read` gets Google's answer (an empty body reads as null, e.g. after DELETE). */
  send: <T>(
    service: GoogleService,
    write: GoogleWrite,
    read: (body: unknown) => T | null
  ) => Promise<T>
  /** A file's bytes, refused with a sentence once they pass `maxBytes`. */
  bytes: (service: GoogleService, url: string, maxBytes?: number) => Promise<Uint8Array>
}

export type WorkspaceApiOptions = {
  email: string
  projectId?: string
  getAccessToken: (force: boolean) => Promise<string> | string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

type RequestSpec = {
  method: string
  url: string
  body?: Uint8Array<ArrayBuffer> | string
  contentType?: string
}

export function createWorkspaceApi(options: WorkspaceApiOptions): GoogleApi {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createWorkspaceApi requires an options object.')
  }
  const email = typeof options.email === 'string' ? options.email.trim() : ''
  if (!email) {
    throw new TypeError('createWorkspaceApi requires a non-empty email.')
  }
  if (typeof options.getAccessToken !== 'function') {
    throw new TypeError('createWorkspaceApi requires getAccessToken(force).')
  }
  const projectId = options.projectId
  const http = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : REQUEST_TIMEOUT_MS

  async function token(force: boolean): Promise<string> {
    const bearer = await options.getAccessToken(force)
    if (typeof bearer !== 'string' || !bearer.trim()) {
      throw new GoogleToolError('Google access ended. Ask your owner to reconnect it.')
    }
    return bearer.trim()
  }

  async function call(
    service: GoogleService,
    request: RequestSpec,
    retried = false
  ): Promise<Response> {
    const targetUrl = assertAllowedGoogleApiUrl(service, request.url)
    const bearer = await token(retried)
    let response: Response
    try {
      response = await http(targetUrl.toString(), {
        method: request.method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(request.contentType ? { 'content-type': request.contentType } : {})
        },
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch {
      // Never blindly retry a timed-out or failed network request (especially writes).
      throw new GoogleToolError("Couldn't reach Google. Try again in a moment.")
    }
    // Never follow redirects with an Authorization header.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined)
      throw new GoogleToolError(
        `Refused unexpected redirect (HTTP ${response.status}) from Google API.`,
        response.status
      )
    }
    // A token can be refused before its saved expiry (revoked session, clock skew): renew once.
    // Retrying a write on explicit HTTP 401 is safe: Google acted on nothing it refused.
    if (response.status === 401 && !retried) {
      await response.body?.cancel().catch(() => undefined)
      return call(service, request, true)
    }
    return response
  }

  async function fail(service: GoogleService, response: Response): Promise<never> {
    const body: unknown = await response.json().catch(() => null)
    throw new GoogleToolError(
      failureSentence(service, response.status, body, projectId),
      response.status
    )
  }

  async function json<T>(
    service: GoogleService,
    request: RequestSpec,
    read: (body: unknown) => T | null,
    absentIsNull: boolean
  ): Promise<T | null> {
    const response = await call(service, request)
    if (absentIsNull && response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    if (!response.ok) {
      return fail(service, response)
    }
    const value = read(parseBody(await response.text()))
    if (value === null) {
      throw new GoogleToolError('Google answered in a shape Orca does not understand.')
    }
    return value
  }

  return {
    email,
    get: async (service, url, read) => {
      const value = await json(service, { method: 'GET', url }, read, false)
      if (value === null) {
        throw new GoogleToolError('Google found nothing there.')
      }
      return value
    },
    find: (service, url, read) => json(service, { method: 'GET', url }, read, true),
    send: async (service, write, read) => {
      if (!WRITE_METHODS.has(write.method)) {
        throw new GoogleToolError(`Unsupported Google write method: ${String(write.method)}.`)
      }
      const body =
        write.raw?.body ?? (write.json !== undefined ? JSON.stringify(write.json) : undefined)
      const contentType =
        write.raw?.contentType ?? (write.json !== undefined ? 'application/json' : undefined)
      const value = await json(
        service,
        {
          method: write.method,
          url: write.url,
          ...(body !== undefined ? { body } : {}),
          ...(contentType ? { contentType } : {})
        },
        read,
        false
      )
      if (value === null) {
        throw new GoogleToolError('Google answered in a shape Orca does not understand.')
      }
      return value
    },
    bytes: async (service, url, maxBytes = TOOL_DOWNLOAD_MAX_BYTES) => {
      if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
        throw new GoogleToolError('Invalid byte limit for Google download.')
      }
      const response = await call(service, { method: 'GET', url })
      if (!response.ok) {
        return fail(service, response)
      }
      const tooLarge = () =>
        new GoogleToolError(
          `That file is larger than ${formatMegabytes(maxBytes)}, more than Orca hands an agent at once. Open it in Google instead.`
        )
      const contentLength = Number(response.headers.get('content-length') ?? 0)
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined)
        throw tooLarge()
      }
      if (!response.body) {
        const buf = Buffer.from(await response.arrayBuffer())
        if (buf.byteLength > maxBytes) {
          throw tooLarge()
        }
        return buf
      }
      const chunks: Uint8Array[] = []
      let total = 0
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw tooLarge()
        }
        chunks.push(value)
      }
      return Buffer.concat(chunks)
    }
  }
}

export function failureSentence(
  service: GoogleService,
  status: number,
  body: unknown,
  projectId: string | undefined
): string {
  const readiness = classifyGoogleApiError(service, readGoogleApiError(status, body), projectId)
  switch (readiness.state) {
    case 'api-disabled':
      return `${readiness.detail ?? 'This Google API is turned off.'} Ask your owner to turn it on: ${readiness.enableUrl ?? googleApiEnableUrl(service, projectId)}`
    case 'needs-permission':
      return 'Google access for this was not allowed. Ask your owner to reconnect it in Orca and allow it.'
    case 'blocked-by-admin':
      return `Your owner's company Google admin blocked this: ${readiness.detail ?? ''}`.trim()
    case 'ready':
    case 'error':
      return status === 401
        ? 'Google refused the sign-in. Ask your owner to reconnect it in Orca.'
        : status === 429
          ? 'Google says too many requests right now. Wait a minute and try again.'
          : `Google refused: ${readiness.detail ?? `HTTP ${status}`}`
  }
}
