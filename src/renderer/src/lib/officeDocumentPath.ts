import type { OfficeDocumentKind } from '../../../shared/officeProtocol'

const OFFICE_KIND_BY_EXTENSION: Readonly<Record<string, OfficeDocumentKind>> = {
  '.xlsx': 'xlsx',
  '.docx': 'docx',
  '.pptx': 'pptx'
}

export function officeDocumentKindForPath(path: string): OfficeDocumentKind | null {
  const normalized = path.toLowerCase()
  for (const [extension, kind] of Object.entries(OFFICE_KIND_BY_EXTENSION)) {
    if (normalized.endsWith(extension)) return kind
  }
  return null
}

export function isOfficeDocumentPath(path: string): boolean {
  return officeDocumentKindForPath(path) !== null
}
