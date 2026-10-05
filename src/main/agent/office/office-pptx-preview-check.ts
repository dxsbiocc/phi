import { officeCliEnv, runOfficeCli } from './office-driver'

export type OfficePptxPreviewCheck =
  | { readonly state: 'ready'; readonly slideCount: number }
  | { readonly state: 'preview_failed'; readonly message: string; readonly slideCount?: number }

export interface OfficePptxPreviewHealthDependencies {
  readonly inspect?: (binaryPath: string, draftPath: string) => Promise<number>
  readonly loadHtml?: (url: string) => Promise<string>
}

export type OfficePptxPreviewHealth =
  | { readonly previewState: 'ready'; readonly slideCount: number }
  | {
      readonly previewState: 'preview_failed'
      readonly previewError: string
      readonly slideCount?: number
    }

const PREVIEW_CHECK_TIMEOUT_MS = 30_000
// OfficeCLI inlines PPTX media in HTML; the check must accept the same bounded page as the gateway.
const MAX_PREVIEW_HTML_BYTES = 40 * 1024 * 1024
const PREVIEW_ENV = { OFFICECLI_RESIDENT_FLUSH: 'each' } as const

const DIV_CLASS = /<div\b[^>]*class=(?:"([^"]*)"|'([^']*)')[^>]*>/giu
const DIV_CLASS_TEXT = /<div\b[^>]*class=(?:"([^"]*)"|'([^']*)')[^>]*>([^<]*)<\/div>/giu

function hasClass(classes: string | undefined, name: string): boolean {
  return classes?.split(/\s+/u).includes(name) ?? false
}

function countDivsWithClass(html: string, name: string): number {
  return [...html.matchAll(DIV_CLASS)].filter((match) => hasClass(match[1] ?? match[2], name))
    .length
}

function pageCounter(html: string): { readonly current: number; readonly total: number } {
  const match = [...html.matchAll(DIV_CLASS_TEXT)].find((candidate) =>
    hasClass(candidate[1] ?? candidate[2], 'page-counter')
  )
  const counter = /^\s*(\d+)\s*\/\s*(\d+)\s*$/u.exec(match?.[3] ?? '')
  return {
    current: Number(counter?.[1] ?? Number.NaN),
    total: Number(counter?.[2] ?? Number.NaN)
  }
}

function failed(message: string, slideCount?: number): OfficePptxPreviewCheck {
  return slideCount === undefined
    ? { state: 'preview_failed', message }
    : { state: 'preview_failed', message, slideCount }
}

export function checkOfficePptxPreview(
  html: string,
  expectedSlides: number
): OfficePptxPreviewCheck {
  if (!Number.isSafeInteger(expectedSlides) || expectedSlides < 0) {
    return failed('PPTX 幻灯片数量无效')
  }
  if (countDivsWithClass(html, 'main') === 0) {
    return failed('预览页面缺少 PowerPoint 演示文稿容器', expectedSlides)
  }
  const renderedSlides = countDivsWithClass(html, 'slide-container')
  const renderedThumbnails = countDivsWithClass(html, 'thumb')
  const counter = pageCounter(html)
  if (
    renderedSlides !== expectedSlides ||
    renderedThumbnails !== expectedSlides ||
    counter.total !== expectedSlides
  ) {
    return failed('预览页面幻灯片数量与文档不一致', expectedSlides)
  }
  if (expectedSlides > 0 && (counter.current < 1 || counter.current > expectedSlides)) {
    return failed('预览页面当前页状态无效', expectedSlides)
  }
  return { state: 'ready', slideCount: expectedSlides }
}

export function parseOfficePptxSlideCount(value: unknown): number {
  const envelope = value as {
    success?: unknown
    data?: {
      results?: Array<{
        path?: unknown
        type?: unknown
        childCount?: unknown
        children?: Array<{ path?: unknown; type?: unknown }>
      }>
    }
  }
  const root = envelope.data?.results?.find((result) => result.path === '/')
  if (
    envelope.success !== true ||
    root?.type !== 'presentation' ||
    !Number.isSafeInteger(root.childCount) ||
    Number(root.childCount) < 0 ||
    !Array.isArray(root.children)
  ) {
    throw new Error('invalid pptx inspection result')
  }
  const slides = root.children.filter(
    (child) => child.type === 'slide' && /^\/slide\[[1-9]\d*\]$/u.test(String(child.path))
  )
  if (slides.length !== root.childCount) throw new Error('invalid pptx inspection result')
  return Number(root.childCount)
}

export async function readOfficePptxSlideCount(
  binaryPath: string,
  draftPath: string
): Promise<number> {
  const result = await runOfficeCli(binaryPath, ['get', draftPath, '/', '--json'], {
    timeoutMs: PREVIEW_CHECK_TIMEOUT_MS,
    env: officeCliEnv(process.env, PREVIEW_ENV)
  })
  if (result.exitCode !== 0 || result.spawnError || result.timedOut || result.truncated) {
    throw new Error('pptx preview inspection failed')
  }
  return parseOfficePptxSlideCount(JSON.parse(result.stdout))
}

export async function loadOfficePptxPreviewHtml(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(PREVIEW_CHECK_TIMEOUT_MS) })
  if (!response.ok) throw new Error('preview html unavailable')
  const html = await response.text()
  if (Buffer.byteLength(html) > MAX_PREVIEW_HTML_BYTES) {
    throw new Error('preview html too large')
  }
  return html
}

export async function inspectStartedOfficePptxPreview(
  binaryPath: string,
  draftPath: string,
  previewUrl: string,
  dependencies: OfficePptxPreviewHealthDependencies = {}
): Promise<OfficePptxPreviewHealth> {
  let slideCount: number | undefined
  try {
    slideCount = await (dependencies.inspect ?? readOfficePptxSlideCount)(binaryPath, draftPath)
    const html = await (dependencies.loadHtml ?? loadOfficePptxPreviewHtml)(previewUrl)
    const result = checkOfficePptxPreview(html, slideCount)
    return result.state === 'ready'
      ? { previewState: 'ready', slideCount }
      : {
          previewState: 'preview_failed',
          previewError: `预览渲染失败：${result.message}`,
          slideCount
        }
  } catch {
    return {
      previewState: 'preview_failed',
      previewError: '预览渲染失败：无法检查预览页面',
      ...(slideCount === undefined ? {} : { slideCount })
    }
  }
}
