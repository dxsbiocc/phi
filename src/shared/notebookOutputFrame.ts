export const NOTEBOOK_OUTPUT_SCHEME = 'phi-output'

// Notebook HTML and JavaScript outputs run in this document, not in the Phi
// window. The app page forbids inline and remote scripts; this policy allows
// them only inside the output frame.
export const NOTEBOOK_OUTPUT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'unsafe-inline' https: data:",
  'img-src https: data: blob:',
  'font-src https: data:',
  'connect-src https: data: blob:',
  'frame-src https: data: blob:',
  'media-src https: data: blob:',
  'worker-src blob: https:',
  "object-src 'none'",
  'base-uri file: https:',
  "form-action 'none'"
].join('; ')

const OUTPUT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function notebookOutputFrameUrl(id: string): string {
  return `${NOTEBOOK_OUTPUT_SCHEME}://${id}/`
}

export function notebookOutputFrameId(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${NOTEBOOK_OUTPUT_SCHEME}:`) return null
    return OUTPUT_ID_PATTERN.test(parsed.hostname) ? parsed.hostname : null
  } catch {
    return null
  }
}
