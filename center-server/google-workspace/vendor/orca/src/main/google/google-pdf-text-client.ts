// A PDF's text, read by a bounded Node worker thread so the Center main thread stays responsive.
// Adapted from upstream src/main/google/google-pdf-text-client.ts for Node 24/26 native TS ESM
// without Electron worker-thread utilities.
import { Worker } from 'node:worker_threads'
import { MAX_PDF_BYTES } from './google-pdf-text.ts'
import type {
  PdfTextWorkerRequest,
  PdfTextWorkerResponse
} from './google-pdf-text-worker-protocol.ts'

const WORKER_TIMEOUT_MS = 30_000
const IDLE_TEARDOWN_MS = 60_000
const MAX_CONSECUTIVE_DEATHS = 3

type PendingJob = {
  id: number
  data: Uint8Array
  resolve: (value: { text: string; pages: number }) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let activeJob: PendingJob | null = null
let activeTimer: ReturnType<typeof setTimeout> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let nextId = 1
let consecutiveDeaths = 0
const pending: PendingJob[] = []

function clearActiveTimer(): void {
  if (activeTimer) {
    clearTimeout(activeTimer)
    activeTimer = null
  }
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdleTeardown(): void {
  clearIdleTimer()
  if (!worker || activeJob || pending.length > 0) {
    return
  }
  worker.unref()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!activeJob && pending.length === 0) {
      void terminateWorker()
    }
  }, IDLE_TEARDOWN_MS)
  idleTimer.unref?.()
}

async function terminateWorker(): Promise<void> {
  clearIdleTimer()
  clearActiveTimer()
  const current = worker
  worker = null
  if (current) {
    current.removeAllListeners()
    await current.terminate().catch(() => undefined)
  }
}

function failActive(error: Error): void {
  clearActiveTimer()
  const job = activeJob
  activeJob = null
  job?.reject(error)
}

function handleWorkerDeath(error: Error): void {
  worker = null
  consecutiveDeaths += 1
  failActive(error)
  if (consecutiveDeaths >= MAX_CONSECUTIVE_DEATHS) {
    const crashError = new Error(`PDF reader crashed repeatedly: ${error.message}`)
    while (pending.length > 0) {
      pending.shift()?.reject(crashError)
    }
    return
  }
  pump()
}

function ensureWorker(): Worker {
  if (worker) {
    return worker
  }
  const entryUrl = new URL('./google-pdf-text-worker-entry.ts', import.meta.url)
  const spawned = new Worker(entryUrl, { name: 'orca-google-pdf-text' })
  spawned.on('message', (response: PdfTextWorkerResponse) => {
    if (!activeJob || response.id !== activeJob.id) {
      return
    }
    clearActiveTimer()
    const job = activeJob
    activeJob = null
    consecutiveDeaths = 0
    if (response.ok) {
      job.resolve({ text: response.text, pages: response.pages })
    } else {
      job.reject(new Error(response.error))
    }
    pump()
  })
  spawned.on('error', (error: Error) => {
    if (worker === spawned) {
      handleWorkerDeath(new Error(`PDF reader unavailable: ${error.message}`))
    }
  })
  spawned.on('exit', (code: number) => {
    if (worker === spawned) {
      handleWorkerDeath(new Error(`PDF reader exited with code ${code}`))
    }
  })
  worker = spawned
  return spawned
}

function pump(): void {
  if (activeJob) {
    return
  }
  const next = pending.shift()
  if (!next) {
    scheduleIdleTeardown()
    return
  }
  clearIdleTimer()
  if (consecutiveDeaths >= MAX_CONSECUTIVE_DEATHS) {
    next.reject(new Error('PDF reader unavailable: crashed repeatedly.'))
    pump()
    return
  }
  let current: Worker
  try {
    current = ensureWorker()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    next.reject(new Error(`PDF reader unavailable: ${message}`))
    pump()
    return
  }
  current.ref()
  activeJob = next
  activeTimer = setTimeout(() => {
    activeTimer = null
    const timedOut = activeJob
    activeJob = null
    void terminateWorker().finally(() => {
      timedOut?.reject(new Error(`PDF reading timed out after ${WORKER_TIMEOUT_MS / 1000}s`))
      pump()
    })
  }, WORKER_TIMEOUT_MS)
  activeTimer.unref?.()
  const request: PdfTextWorkerRequest = { id: next.id, data: next.data }
  current.postMessage(request)
}

export async function pdfTextViaWorker(data: Uint8Array): Promise<{ text: string; pages: number }> {
  if (!(data instanceof Uint8Array)) {
    throw new Error('PDF input must be a Uint8Array.')
  }
  if (data.byteLength === 0) {
    throw new Error('PDF input is empty.')
  }
  if (data.byteLength > MAX_PDF_BYTES) {
    throw new Error(`PDF exceeds the ${MAX_PDF_BYTES}-byte text extraction limit.`)
  }
  return new Promise((resolve, reject) => {
    pending.push({ id: nextId++, data, resolve, reject })
    pump()
  })
}

export async function closePdfTextWorker(): Promise<void> {
  const closedError = new Error('PDF reader closed.')
  failActive(closedError)
  while (pending.length > 0) {
    pending.shift()?.reject(closedError)
  }
  consecutiveDeaths = 0
  await terminateWorker()
}
