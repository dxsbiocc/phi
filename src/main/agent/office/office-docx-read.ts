import { officeCliEnv, runOfficeCli } from './office-driver'
import { OfficeDocumentCursorCodec } from './office-document-cursor'
import {
  OfficeReadError,
  type OfficeReadContext,
  type OfficeReadParams,
  type OfficeReadResponse
} from './office-read-contract'
import { parseOfficeReadJson } from './office-read-parser'
import { parseOfficeDocxParagraph } from './office-docx-paragraph'
import type { OfficePptxReadResult } from './office-pptx-read'

export const OFFICE_DOCX_READ_LIMITS = Object.freeze({
  defaultParagraphs: 50,
  maxParagraphs: 200,
  maxParagraphBytes: 16 * 1024,
  maxTextBytes: 192 * 1024,
  maxBytes: 256 * 1024,
  maxCursorLength: 2_048
})

export interface OfficeDocxParagraph {
  readonly paraId: string
  readonly index: number
  readonly text: string
  readonly style?: string
  readonly editable: boolean
  readonly truncated: boolean
}

export interface OfficeDocxReadResult {
  readonly revision: number
  readonly paragraphs: readonly OfficeDocxParagraph[]
  readonly total: number
  readonly complete: boolean
  readonly truncated: boolean
  readonly nextCursor?: string
  readonly limits: {
    readonly maxParagraphs: number
    readonly maxParagraphBytes: number
    readonly maxTextBytes: number
    readonly maxBytes: number
  }
}

export type OfficeDocumentReadResponse =
  OfficeReadResponse | OfficeDocxReadResult | OfficePptxReadResult

interface OfficeDocxReaderDependencies {
  readonly run?: typeof runOfficeCli
  readonly cursorSecret?: Buffer
}

interface ParsedParagraph {
  readonly paraId: string
  readonly text: string
  readonly style?: string
  readonly editable: boolean
}

export class OfficeDocxReader {
  private readonly run: typeof runOfficeCli
  private readonly cursor: OfficeDocumentCursorCodec

  constructor(dependencies: OfficeDocxReaderDependencies = {}) {
    this.run = dependencies.run ?? runOfficeCli
    this.cursor = new OfficeDocumentCursorCodec(dependencies.cursorSecret)
  }

  async read(context: OfficeReadContext, params: OfficeReadParams): Promise<OfficeDocxReadResult> {
    const page = this.resolvePage(context, params)
    const result = await this.run(
      context.binaryPath,
      ['get', context.draftPath, '/body', '--depth', '2', '--json'],
      {
        timeoutMs: 30_000,
        signal: context.signal,
        env: officeCliEnv()
      }
    )
    const paragraphs = parseParagraphs(parseOfficeReadJson(result))
    return this.createPage(context, paragraphs, page)
  }

  private resolvePage(
    context: OfficeReadContext,
    params: OfficeReadParams
  ): { readonly from: number; readonly limit: number } {
    assertDocxReadParams(params)
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
        params.limit ?? OFFICE_DOCX_READ_LIMITS.defaultParagraphs,
        OFFICE_DOCX_READ_LIMITS.maxParagraphs
      )
    }
  }

  private createPage(
    context: OfficeReadContext,
    source: readonly ParsedParagraph[],
    page: { readonly from: number; readonly limit: number }
  ): OfficeDocxReadResult {
    if (page.from > source.length) throw invalidCursor()
    const paragraphs: OfficeDocxParagraph[] = []
    let textBytes = 0
    let nextIndex = page.from
    let textWasTruncated = false
    while (nextIndex < source.length && paragraphs.length < page.limit) {
      const paragraph = source[nextIndex]!
      const remaining = OFFICE_DOCX_READ_LIMITS.maxTextBytes - textBytes
      if (remaining <= 0) break
      const maxBytes = Math.min(remaining, OFFICE_DOCX_READ_LIMITS.maxParagraphBytes)
      const text = truncateUtf8(paragraph.text, maxBytes)
      const truncated = text !== paragraph.text
      textWasTruncated ||= truncated
      textBytes += Buffer.byteLength(text, 'utf8')
      paragraphs.push(
        Object.freeze({
          paraId: paragraph.paraId,
          index: nextIndex,
          text,
          ...(paragraph.style ? { style: paragraph.style } : {}),
          editable: paragraph.editable,
          truncated
        })
      )
      nextIndex += 1
    }
    const complete = nextIndex >= source.length
    const response = {
      revision: context.revision,
      paragraphs: Object.freeze(paragraphs),
      total: source.length,
      complete,
      truncated: textWasTruncated || !complete,
      ...(complete
        ? {}
        : {
            nextCursor: this.cursor.encode({
              artifactId: context.artifactId,
              revision: context.revision,
              nextIndex,
              limit: page.limit
            })
          }),
      limits: {
        maxParagraphs: OFFICE_DOCX_READ_LIMITS.maxParagraphs,
        maxParagraphBytes: OFFICE_DOCX_READ_LIMITS.maxParagraphBytes,
        maxTextBytes: OFFICE_DOCX_READ_LIMITS.maxTextBytes,
        maxBytes: OFFICE_DOCX_READ_LIMITS.maxBytes
      }
    } satisfies OfficeDocxReadResult
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > OFFICE_DOCX_READ_LIMITS.maxBytes) {
      throw new OfficeReadError('range_too_large', '段落读取结果超过 256 KiB 上限')
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

export function assertDocxReadParams(params: OfficeReadParams): void {
  if (params.sheet !== undefined || params.range !== undefined || params.maxCells !== undefined) {
    throw new OfficeReadError('invalid_arguments', 'Word 段落读取不接受 sheet、range 或 maxCells')
  }
  if (params.cursor !== undefined) {
    if (params.from !== undefined || params.limit !== undefined) throw invalidCursor()
    if (
      params.cursor.length === 0 ||
      params.cursor.length > OFFICE_DOCX_READ_LIMITS.maxCursorLength
    )
      throw invalidCursor()
    return
  }
  if (params.from !== undefined && !validIndex(params.from)) {
    throw new OfficeReadError('invalid_arguments', 'from 必须是非负整数')
  }
  if (params.limit !== undefined && !validLimit(params.limit)) {
    throw new OfficeReadError('invalid_arguments', 'limit 必须是 1 到 200 的整数')
  }
}

function parseParagraphs(value: unknown): readonly ParsedParagraph[] {
  if (!isRecord(value) || !isRecord(value.data) || !Array.isArray(value.data.results)) {
    throw new OfficeReadError('read_failed', 'OfficeCLI 返回了无效的 Word 正文')
  }
  const body = value.data.results.find((entry) => isRecord(entry) && entry.path === '/body')
  if (!isRecord(body) || !Array.isArray(body.children)) {
    throw new OfficeReadError('read_failed', 'OfficeCLI 返回了无效的 Word 正文')
  }
  return Object.freeze(body.children.flatMap((child) => parseParagraph(child)))
}

function parseParagraph(value: unknown): ParsedParagraph[] {
  try {
    const paragraph = parseOfficeDocxParagraph(value)
    return paragraph ? [paragraph] : []
  } catch {
    throw new OfficeReadError('read_failed', 'Word 段落缺少稳定定位信息')
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
  return validIndex(value) && value >= 1 && value <= OFFICE_DOCX_READ_LIMITS.maxParagraphs
}

function invalidCursor(): OfficeReadError {
  return new OfficeReadError('invalid_cursor', '继续读取标记无效或已过期')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
