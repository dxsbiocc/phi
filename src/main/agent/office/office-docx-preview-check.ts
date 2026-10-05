export type OfficeDocxPreviewCheck =
  { readonly state: 'ready' } | { readonly state: 'preview_failed'; readonly message: string }

export interface OfficeDocxPreviewHealthDependencies {
  readonly inspect?: (binaryPath: string, draftPath: string) => Promise<readonly string[]>
  readonly loadHtml?: (url: string) => Promise<string>
}

export type OfficeDocxPreviewHealth = {
  readonly previewState: 'ready' | 'preview_failed'
  readonly previewError?: string
}

const DOCUMENT_CONTAINER =
  /<div\b[^>]*class=(?:"[^"]*\bpage-body\b[^"]*"|'[^']*\bpage-body\b[^']*')[^>]*>/iu
const PREVIEW_CHECK_TIMEOUT_MS = 30_000
const MAX_PREVIEW_HTML_BYTES = 1024 * 1024
const PREVIEW_ENV = { OFFICECLI_RESIDENT_FLUSH: 'each' } as const

function escapedText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function checkOfficeDocxPreview(
  html: string,
  sampleTexts: readonly string[]
): OfficeDocxPreviewCheck {
  if (!DOCUMENT_CONTAINER.test(html)) {
    return { state: 'preview_failed', message: '预览页面缺少 Word 文档容器' }
  }
  const missingText = sampleTexts.find((text) => text && !html.includes(escapedText(text)))
  if (missingText) {
    return { state: 'preview_failed', message: '预览页面未显示文档正文' }
  }
  return { state: 'ready' }
}

export async function readOfficeDocxPreviewSamples(
  binaryPath: string,
  draftPath: string
): Promise<readonly string[]> {
  const result = await runOfficeCli(binaryPath, ['view', draftPath, 'text', '--json'], {
    timeoutMs: PREVIEW_CHECK_TIMEOUT_MS,
    env: officeCliEnv(process.env, PREVIEW_ENV)
  })
  if (result.exitCode !== 0 || result.spawnError || result.timedOut || result.truncated) {
    throw new Error('docx preview inspection failed')
  }
  return parseDocumentInspection(JSON.parse(result.stdout)).sampleTexts
}

export async function loadOfficePreviewHtml(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(PREVIEW_CHECK_TIMEOUT_MS) })
  if (!response.ok) throw new Error('preview html unavailable')
  const html = await response.text()
  if (Buffer.byteLength(html) > MAX_PREVIEW_HTML_BYTES) {
    throw new Error('preview html too large')
  }
  return html
}

export async function inspectStartedOfficeDocxPreview(
  binaryPath: string,
  draftPath: string,
  previewUrl: string,
  dependencies: OfficeDocxPreviewHealthDependencies = {}
): Promise<OfficeDocxPreviewHealth> {
  try {
    const samples = await (dependencies.inspect ?? readOfficeDocxPreviewSamples)(
      binaryPath,
      draftPath
    )
    const html = await (dependencies.loadHtml ?? loadOfficePreviewHtml)(previewUrl)
    const result = checkOfficeDocxPreview(html, samples)
    return result.state === 'ready'
      ? { previewState: 'ready' }
      : { previewState: 'preview_failed', previewError: `预览渲染失败：${result.message}` }
  } catch {
    return { previewState: 'preview_failed', previewError: '预览渲染失败：无法检查预览页面' }
  }
}
import { officeCliEnv, runOfficeCli } from './office-driver'
import { parseDocumentInspection } from './office-process'
