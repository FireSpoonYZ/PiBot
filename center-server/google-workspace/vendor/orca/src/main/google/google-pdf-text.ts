// A PDF's text, extracted here so the file never goes to another service. Loaded only when a PDF
// is read, since the PDF reader is large.
// Adapted from upstream src/main/google/google-pdf-text.ts: adds explicit byte, page and output
// bounds plus `isEvalSupported: false`, and fails explicitly when pdfjs-dist is missing or corrupt.

export const MAX_PDF_BYTES = 10 * 1024 * 1024
export const MAX_PDF_PAGES = 200
export const MAX_PDF_TEXT_CHARS = 512 * 1024

/** Each page's text, pages separated by a marked line, bounded by bytes, pages and characters. */
export async function pdfText(data: Uint8Array): Promise<{ text: string; pages: number }> {
  if (!(data instanceof Uint8Array)) {
    throw new Error('PDF input must be a Uint8Array.')
  }
  if (data.byteLength === 0) {
    throw new Error('PDF input is empty.')
  }
  if (data.byteLength > MAX_PDF_BYTES) {
    throw new Error(`PDF exceeds the ${MAX_PDF_BYTES}-byte text extraction limit.`)
  }
  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs')
  try {
    // The reader runs its worker in this thread when the worker's module is already loaded.
    if (!Reflect.has(globalThis, 'pdfjsWorker')) {
      Reflect.set(globalThis, 'pdfjsWorker', await import('pdfjs-dist/legacy/build/pdf.worker.mjs'))
    }
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`PDF text extractor unavailable: ${reason}`)
  }
  const task = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0
  })
  const doc = await task.promise
  try {
    const pages: string[] = []
    const pageLimit = Math.min(doc.numPages, MAX_PDF_PAGES)
    let totalChars = 0
    let truncated = false
    for (let number = 1; number <= pageLimit; number++) {
      const page = await doc.getPage(number)
      const content = await page.getTextContent()
      const line = content.items
        .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : ''))
        .join('')
      const block = `--- page ${number} ---\n${line.trim()}`
      if (totalChars + block.length > MAX_PDF_TEXT_CHARS) {
        const remaining = Math.max(0, MAX_PDF_TEXT_CHARS - totalChars)
        if (remaining > 0) {
          pages.push(block.slice(0, remaining))
        }
        truncated = true
        break
      }
      pages.push(block)
      totalChars += block.length + 2
    }
    if (truncated || doc.numPages > MAX_PDF_PAGES) {
      pages.push(
        `[PDF text truncated after ${pages.length} of ${doc.numPages} pages (limit: ${MAX_PDF_PAGES} pages / ${MAX_PDF_TEXT_CHARS} chars).]`
      )
    }
    return { text: pages.join('\n\n'), pages: doc.numPages }
  } finally {
    await task.destroy()
  }
}
