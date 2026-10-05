import { officePackageEntries } from './office-open-xml-package'
import { OFFICE_PRESENTATION_LIMITS } from './office-limits'

export type OfficePptxPackageErrorCode = 'missing_part' | 'invalid_slides' | 'too_many_slides'

export class OfficePptxPackageError extends Error {
  constructor(
    readonly code: OfficePptxPackageErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'OfficePptxPackageError'
  }
}

function assertContiguousSlideParts(entries: ReadonlySet<string>): void {
  const directXmlEntries = [...entries].filter(
    (entry) => entry.startsWith('ppt/slides/') && entry.slice('ppt/slides/'.length).endsWith('.xml')
  )
  const indexes = directXmlEntries
    .map((entry) => /^ppt\/slides\/slide([1-9]\d*)\.xml$/u.exec(entry))
    .map((match) => (match ? Number(match[1]) : Number.NaN))
    .sort((left, right) => left - right)
  if (indexes.some((value, index) => value !== index + 1)) {
    throw new OfficePptxPackageError('invalid_slides', 'invalid pptx slide parts')
  }
  if (indexes.length > OFFICE_PRESENTATION_LIMITS.maxSlides) {
    throw new OfficePptxPackageError('too_many_slides', 'too many pptx slides')
  }
}

export function assertOfficePptxPackage(bytes: Buffer): void {
  const entries = officePackageEntries(bytes)
  const required = ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml']
  if (required.some((entry) => !entries.has(entry))) {
    throw new OfficePptxPackageError('missing_part', 'missing pptx package part')
  }
  assertContiguousSlideParts(entries)
}
