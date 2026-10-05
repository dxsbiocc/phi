import { readFile } from 'node:fs/promises'

import { OfficeDocumentCursorCodec } from './office-document-cursor'
import { officeCliEnv, runOfficeCli } from './office-driver'
import type {
  OfficePptxElementSnapshot,
  OfficePptxSlideSnapshot,
  OfficePptxSnapshot
} from './office-pptx-contract'
import {
  OfficeReadError,
  type OfficeReadContext,
  type OfficeReadParams
} from './office-read-contract'
import { parseOfficePptxSnapshot } from './office-pptx-snapshot'

export const OFFICE_PPTX_READ_LIMITS = Object.freeze({
  defaultSlides: 20,
  maxSlides: 50,
  maxElementsPerSlide: 100,
  maxElementBytes: 8 * 1024,
  maxSlideTextBytes: 32 * 1024,
  maxTextBytes: 192 * 1024,
  maxBytes: 256 * 1024,
  maxCursorLength: 2_048
})

export interface OfficePptxReadElement {
  readonly elementId: string
  readonly path: string
  readonly kind: 'title' | 'body' | 'text'
  readonly text: string
  readonly editable: boolean
  readonly truncated: boolean
}

export interface OfficePptxReadSlide {
  readonly slideId: string
  readonly index: number
  readonly title?: string
  readonly elements: readonly OfficePptxReadElement[]
}

export interface OfficePptxReadResult {
  readonly revision: number
  readonly slides: readonly OfficePptxReadSlide[]
  readonly total: number
  readonly complete: boolean
  readonly truncated: boolean
  readonly nextCursor?: string
  readonly limits: {
    readonly maxSlides: number
    readonly maxElementsPerSlide: number
    readonly maxElementBytes: number
    readonly maxSlideTextBytes: number
    readonly maxTextBytes: number
    readonly maxBytes: number
  }
}

interface OfficePptxReaderDependencies {
  readonly run?: typeof runOfficeCli
  readonly cursorSecret?: Buffer
  readonly readPackage?: (path: string) => Promise<Buffer>
}

export class OfficePptxReader {
  private readonly run: typeof runOfficeCli
  private readonly cursor: OfficeDocumentCursorCodec
  private readonly readPackage: (path: string) => Promise<Buffer>

  constructor(dependencies: OfficePptxReaderDependencies = {}) {
    this.run = dependencies.run ?? runOfficeCli
    this.cursor = new OfficeDocumentCursorCodec(dependencies.cursorSecret)
    this.readPackage = dependencies.readPackage ?? readFile
  }

  async read(context: OfficeReadContext, params: OfficeReadParams): Promise<OfficePptxReadResult> {
    const page = this.resolvePage(context, params)
    const result = await this.run(
      context.binaryPath,
      ['get', context.draftPath, '/', '--depth', '5', '--json'],
      { timeoutMs: 30_000, signal: context.signal, env: officeCliEnv() }
    )
    let snapshot: OfficePptxSnapshot
    try {
      snapshot = parseOfficePptxSnapshot(result, await this.readPackage(context.draftPath))
    } catch {
      throw new OfficeReadError('read_failed', '无法读取 PowerPoint 幻灯片文本')
    }
    return this.createPage(context, snapshot, page)
  }

  private resolvePage(
    context: OfficeReadContext,
    params: OfficeReadParams
  ): { readonly from: number; readonly limit: number } {
    assertPptxReadParams(params)
    if (params.cursor) {
      const cursor = this.decodeCursor(params.cursor)
      if (cursor.artifactId !== context.artifactId || cursor.revision !== context.revision) {
        throw invalidCursor()
      }
      return { from: cursor.nextIndex, limit: cursor.limit }
    }
    return {
      from: params.from ?? 0,
      limit: Math.min(
        params.limit ?? OFFICE_PPTX_READ_LIMITS.defaultSlides,
        OFFICE_PPTX_READ_LIMITS.maxSlides
      )
    }
  }

  private createPage(
    context: OfficeReadContext,
    snapshot: OfficePptxSnapshot,
    page: { readonly from: number; readonly limit: number }
  ): OfficePptxReadResult {
    if (page.from > snapshot.slideCount) throw invalidCursor()
    const slides: OfficePptxReadSlide[] = []
    let nextIndex = page.from
    let textBytes = 0
    let textWasTruncated = false
    while (nextIndex < snapshot.slideCount && slides.length < page.limit) {
      const available = OFFICE_PPTX_READ_LIMITS.maxTextBytes - textBytes
      const built = buildSlide(snapshot.slides[nextIndex]!, available)
      if (!built && slides.length > 0) break
      if (!built) throw new OfficeReadError('range_too_large', '单张幻灯片文本超过读取上限')
      slides.push(built.slide)
      textBytes += built.textBytes
      textWasTruncated ||= built.truncated
      nextIndex += 1
    }
    return this.response(
      context,
      snapshot.slideCount,
      slides,
      nextIndex,
      page.limit,
      textWasTruncated
    )
  }

  private response(
    context: OfficeReadContext,
    total: number,
    slides: readonly OfficePptxReadSlide[],
    nextIndex: number,
    limit: number,
    textWasTruncated: boolean
  ): OfficePptxReadResult {
    const complete = nextIndex >= total
    const nextCursor = complete
      ? undefined
      : this.cursor.encode({
          artifactId: context.artifactId,
          revision: context.revision,
          nextIndex,
          limit
        })
    const response = responseValue(context, slides, total, complete, textWasTruncated, nextCursor)
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > OFFICE_PPTX_READ_LIMITS.maxBytes) {
      throw new OfficeReadError('range_too_large', '幻灯片读取结果超过 256 KiB 上限')
    }
    return Object.freeze(response)
  }

  private decodeCursor(value: string): ReturnType<OfficeDocumentCursorCodec['decode']> {
    try {
      return this.cursor.decode(value, validLimit)
    } catch {
      throw invalidCursor()
    }
  }
}

function responseValue(
  context: OfficeReadContext,
  slides: readonly OfficePptxReadSlide[],
  total: number,
  complete: boolean,
  textWasTruncated: boolean,
  nextCursor?: string
): OfficePptxReadResult {
  return {
    revision: context.revision,
    slides: Object.freeze([...slides]),
    total,
    complete,
    truncated: textWasTruncated || !complete,
    ...(nextCursor ? { nextCursor } : {}),
    limits: {
      maxSlides: OFFICE_PPTX_READ_LIMITS.maxSlides,
      maxElementsPerSlide: OFFICE_PPTX_READ_LIMITS.maxElementsPerSlide,
      maxElementBytes: OFFICE_PPTX_READ_LIMITS.maxElementBytes,
      maxSlideTextBytes: OFFICE_PPTX_READ_LIMITS.maxSlideTextBytes,
      maxTextBytes: OFFICE_PPTX_READ_LIMITS.maxTextBytes,
      maxBytes: OFFICE_PPTX_READ_LIMITS.maxBytes
    }
  }
}

function buildSlide(
  source: OfficePptxSlideSnapshot,
  remainingBytes: number
):
  | { readonly slide: OfficePptxReadSlide; readonly textBytes: number; readonly truncated: boolean }
  | undefined {
  if (remainingBytes <= 0) return undefined
  const elements: OfficePptxReadElement[] = []
  let textBytes = 0
  let truncated = source.elements.length > OFFICE_PPTX_READ_LIMITS.maxElementsPerSlide
  for (const element of source.elements.slice(0, OFFICE_PPTX_READ_LIMITS.maxElementsPerSlide)) {
    const maxBytes = Math.min(
      OFFICE_PPTX_READ_LIMITS.maxElementBytes,
      OFFICE_PPTX_READ_LIMITS.maxSlideTextBytes - textBytes,
      remainingBytes - textBytes
    )
    const text = truncateUtf8(element.text, Math.max(0, maxBytes))
    const elementTruncated = text !== element.text
    truncated ||= elementTruncated
    textBytes += Buffer.byteLength(text, 'utf8')
    elements.push(publicElement(element, text, elementTruncated))
  }
  const title = elements.find((element) => element.kind === 'title')?.text
  return {
    slide: Object.freeze({
      slideId: source.slideId,
      index: source.index,
      ...(title === undefined ? {} : { title }),
      elements: Object.freeze(elements)
    }),
    textBytes,
    truncated
  }
}

function publicElement(
  source: OfficePptxElementSnapshot,
  text: string,
  truncated: boolean
): OfficePptxReadElement {
  return Object.freeze({
    elementId: source.elementId,
    path: source.path,
    kind: source.kind,
    text,
    editable: source.editable && !truncated,
    truncated
  })
}

export function assertPptxReadParams(params: OfficeReadParams): void {
  if (params.sheet !== undefined || params.range !== undefined || params.maxCells !== undefined) {
    throw new OfficeReadError('invalid_arguments', 'PowerPoint 读取不接受 sheet、range 或 maxCells')
  }
  if (params.cursor !== undefined) {
    if (params.from !== undefined || params.limit !== undefined) throw invalidCursor()
    if (
      params.cursor.length === 0 ||
      params.cursor.length > OFFICE_PPTX_READ_LIMITS.maxCursorLength
    ) {
      throw invalidCursor()
    }
    return
  }
  if (params.from !== undefined && !validIndex(params.from)) {
    throw new OfficeReadError('invalid_arguments', 'from 必须是非负整数')
  }
  if (params.limit !== undefined && !validLimit(params.limit)) {
    throw new OfficeReadError('invalid_arguments', 'limit 必须是 1 到 50 的整数')
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let result = ''
  let bytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return result
}

function validIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validLimit(value: unknown): value is number {
  return validIndex(value) && value >= 1 && value <= OFFICE_PPTX_READ_LIMITS.maxSlides
}

function invalidCursor(): OfficeReadError {
  return new OfficeReadError('invalid_cursor', '继续读取标记无效或已过期')
}
