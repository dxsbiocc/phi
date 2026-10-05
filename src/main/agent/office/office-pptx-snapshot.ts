import type { OfficeCliRunResult } from './office-driver'
import type { OfficePptxSlideSnapshot, OfficePptxSnapshot } from './office-pptx-contract'
import { parseOfficePptxElement } from './office-pptx-element'
import { readOfficePptxSlideIds } from './office-pptx-identity'
import { OfficeWriteError } from './office-write-contract'

export function parseOfficePptxSnapshot(
  result: OfficeCliRunResult,
  packageBytes: Buffer
): OfficePptxSnapshot {
  const root = presentationRoot(parseEnvelope(result))
  const slideIds = readOfficePptxSlideIds(packageBytes)
  if (root.childCount !== slideIds.length || root.children.length !== slideIds.length) {
    throw invalidReadback()
  }
  const slides = root.children.map((value, index) => parseSlide(value, slideIds[index]!, index))
  return Object.freeze({ slides: Object.freeze(slides), slideCount: slides.length })
}

function parseSlide(value: unknown, slideId: string, index: number): OfficePptxSlideSnapshot {
  if (
    !isRecord(value) ||
    value.type !== 'slide' ||
    value.path !== `/slide[${index + 1}]` ||
    !Array.isArray(value.children)
  ) {
    throw invalidReadback()
  }
  const elements = value.children.flatMap((entry) => {
    const element = parseOfficePptxElement(entry, slideId, index + 1)
    return element ? [Object.freeze(element)] : []
  })
  if (new Set(elements.map((entry) => entry.elementId)).size !== elements.length) {
    throw invalidReadback()
  }
  const title = elements.find((element) => element.kind === 'title')?.text
  return Object.freeze({
    slideId,
    index,
    ...(title === undefined ? {} : { title }),
    elements: Object.freeze(elements)
  })
}

function presentationRoot(value: Record<string, unknown>): {
  readonly childCount: number
  readonly children: readonly unknown[]
} {
  const data = isRecord(value.data) ? value.data : undefined
  const results = Array.isArray(data?.results) ? data.results : []
  const root = results.find((entry) => isRecord(entry) && entry.path === '/')
  if (
    !isRecord(root) ||
    root.type !== 'presentation' ||
    !validCount(root.childCount) ||
    !Array.isArray(root.children)
  ) {
    throw invalidReadback()
  }
  return { childCount: root.childCount, children: root.children }
}

function parseEnvelope(result: OfficeCliRunResult): Record<string, unknown> {
  if (result.timedOut || result.spawnError || result.truncated || result.exitCode !== 0) {
    throw invalidReadback()
  }
  try {
    const value = JSON.parse(result.stdout) as unknown
    if (!isRecord(value) || value.success !== true || hasWarnings(value)) throw new Error('invalid')
    return value
  } catch {
    throw invalidReadback()
  }
}

function hasWarnings(value: Record<string, unknown>): boolean {
  if (Array.isArray(value.warnings) ? value.warnings.length > 0 : value.warnings != null)
    return true
  const data = isRecord(value.data) ? value.data : undefined
  return Array.isArray(data?.warnings) ? data.warnings.length > 0 : data?.warnings != null
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 200
}

function invalidReadback(): OfficeWriteError {
  return new OfficeWriteError('write_failed', 'Office 返回了无效的 PowerPoint 文本快照')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
