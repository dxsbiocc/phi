export interface ParsedOfficeDocxParagraph {
  readonly paraId: string
  readonly text: string
  readonly style?: string
  readonly editable: boolean
}

export function parseOfficeDocxParagraph(value: unknown): ParsedOfficeDocxParagraph | undefined {
  if (!isRecord(value) || value.type !== 'paragraph') return undefined
  const paraId = isRecord(value.format) ? value.format.paraId : undefined
  if (
    typeof paraId !== 'string' ||
    !/^[0-9A-F]{8}$/iu.test(paraId) ||
    typeof value.text !== 'string'
  ) {
    throw new Error('invalid paragraph')
  }
  const style = typeof value.style === 'string' && value.style ? value.style : undefined
  return {
    paraId: paraId.toUpperCase(),
    text: value.text,
    ...(style ? { style } : {}),
    editable: isPlainParagraph(value) && hasBoundedPlainText(value.text)
  }
}

function hasBoundedPlainText(value: string): boolean {
  if (value.length > OFFICE_DOCUMENT_LIMITS.maxParagraphTextLength) return false
  return [...value].every((character) => {
    const code = character.charCodeAt(0)
    return code === 9 || (code >= 32 && code !== 127 && !(code >= 0x80 && code <= 0x9f))
  })
}

function isPlainParagraph(value: Record<string, unknown>): boolean {
  if (value.childCount !== 1 || !Array.isArray(value.children) || value.children.length !== 1) {
    return false
  }
  const run = value.children[0]
  return Boolean(
    isRecord(run) &&
    run.type === 'run' &&
    run.childCount === 0 &&
    typeof run.text === 'string' &&
    run.text === value.text &&
    Array.isArray(run.children) &&
    run.children.length === 0
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
import { OFFICE_DOCUMENT_LIMITS } from './office-limits'
