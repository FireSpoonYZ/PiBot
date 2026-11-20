// Worker-thread entrypoint for bounded PDF text extraction.
// Adapted from upstream src/main/google/google-pdf-text-worker-entry.ts for Center Node ESM
// without Electron worker-send-ledger dependencies.
import { parentPort } from 'node:worker_threads'
import { pdfText } from './google-pdf-text.ts'
import type {
  PdfTextWorkerRequest,
  PdfTextWorkerResponse
} from './google-pdf-text-worker-protocol.ts'

if (parentPort) {
  const port = parentPort
  port.on('message', (request: PdfTextWorkerRequest) => {
    void (async () => {
      try {
        const result = await pdfText(request.data)
        const response: PdfTextWorkerResponse = { id: request.id, ok: true, ...result }
        port.postMessage(response)
      } catch (error) {
        const response: PdfTextWorkerResponse = {
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }
        port.postMessage(response)
      }
    })()
  })
}
