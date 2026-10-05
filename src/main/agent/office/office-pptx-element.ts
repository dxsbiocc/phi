import { OFFICE_PRESENTATION_LIMITS } from './office-limits'
import { officePptxStableElementPath } from './office-pptx-identity'

export type OfficePptxElementKind = 'title' | 'body' | 'text'

export interface OfficePptxElementGeometry {
  readonly widthPoints: number
  readonly heightPoints: number
  readonly fontSizePoints: number
}

export interface ParsedOfficePptxElement {
  readonly elementId: string
  readonly path: string
  readonly cliPath: string
  readonly kind: OfficePptxElementKind
  readonly text: string
  readonly editable: boolean
  readonly geometry?: OfficePptxElementGeometry
}

export function parseOfficePptxElement(
  value: unknown,
  slideId: string,
  slideIndex: number
): ParsedOfficePptxElement | undefined {
  if (!isRecord(value) || typeof value.text !== 'string' || !isRecord(value.format)) {
    return undefined
  }
  const elementId = normalizeElementId(value.format.id)
  const cliPath = typeof value.path === 'string' ? value.path : ''
  if (!elementId || !validCliPath(cliPath, slideIndex, elementId)) {
    throw new Error('invalid shape identity')
  }
  const kind = elementKind(value)
  const geometry = elementGeometry(value.format)
  return {
    elementId,
    path: officePptxStableElementPath(slideId, elementId),
    cliPath,
    kind,
    text: value.text,
    editable: isPlainTextElement(value, kind),
    ...(geometry ? { geometry } : {})
  }
}

export function officePptxLayoutWarning(
  text: string,
  kind: OfficePptxElementKind,
  geometry?: OfficePptxElementGeometry
): 'text_may_overflow' | undefined {
  const capacity = geometry ? geometryCapacity(geometry) : kind === 'title' ? 60 : 600
  const lines = text.split('\n')
  const weighted = lines.reduce((total, line) => total + visualWidth(line), 0)
  const forcedLines = Math.max(0, lines.length - 1) * Math.max(1, capacity / 4)
  return weighted + forcedLines > capacity ? 'text_may_overflow' : undefined
}

function isPlainTextElement(value: Record<string, unknown>, kind: OfficePptxElementKind): boolean {
  const limit =
    kind === 'title'
      ? OFFICE_PRESENTATION_LIMITS.maxTitleTextLength
      : OFFICE_PRESENTATION_LIMITS.maxBodyTextLength
  if (
    typeof value.text !== 'string' ||
    value.text.length > limit ||
    hasUnsupportedText(value.text)
  ) {
    return false
  }
  if (value.childCount !== 1 || !Array.isArray(value.children) || value.children.length !== 1) {
    return false
  }
  const paragraph = value.children[0]
  if (!isRecord(paragraph) || paragraph.type !== 'paragraph') return false
  if (
    paragraph.childCount !== 1 ||
    !Array.isArray(paragraph.children) ||
    paragraph.children.length !== 1
  )
    return false
  const run = paragraph.children[0]
  return Boolean(
    isRecord(run) &&
    run.type === 'run' &&
    run.childCount === 0 &&
    Array.isArray(run.children) &&
    run.children.length === 0 &&
    run.text === value.text
  )
}

function elementKind(value: Record<string, unknown>): OfficePptxElementKind {
  const format = value.format as Record<string, unknown>
  if (value.type === 'title' || format.phType === 'title' || format.isTitle === true) return 'title'
  if (format.phType === 'body') return 'body'
  return 'text'
}

function elementGeometry(format: Record<string, unknown>): OfficePptxElementGeometry | undefined {
  const widthPoints = measurementInPoints(format.width)
  const heightPoints = measurementInPoints(format.height)
  const fontSizePoints = measurementInPoints(format['effective.size'])
  if (!widthPoints || !heightPoints || !fontSizePoints) return undefined
  return { widthPoints, heightPoints, fontSizePoints }
}

function measurementInPoints(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d+(?:\.\d+)?)(pt|cm)$/u.exec(value)
  if (!match) return undefined
  const number = Number(match[1])
  const points = match[2] === 'cm' ? number * (72 / 2.54) : number
  return Number.isFinite(points) && points > 0 ? points : undefined
}

function geometryCapacity(geometry: OfficePptxElementGeometry): number {
  const columns = Math.max(1, Math.floor(geometry.widthPoints / geometry.fontSizePoints))
  const rows = Math.max(1, Math.floor(geometry.heightPoints / (geometry.fontSizePoints * 1.2)))
  return columns * rows
}

function visualWidth(value: string): number {
  return [...value].reduce(
    (total, character) => total + (/^[\x20-\x7e]$/u.test(character) ? 0.5 : 1),
    0
  )
}

function hasUnsupportedText(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return (
      code === 10 ||
      code === 13 ||
      (code < 32 && code !== 9) ||
      code === 127 ||
      (code >= 0x80 && code <= 0x9f)
    )
  })
}

function normalizeElementId(value: unknown): string | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 0xffffffff
    ? String(value)
    : undefined
}

function validCliPath(path: string, slideIndex: number, elementId: string): boolean {
  return path === `/slide[${slideIndex}]/shape[@id=${elementId}]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
