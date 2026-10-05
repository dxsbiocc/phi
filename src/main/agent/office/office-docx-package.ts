import { officePackageEntries } from './office-open-xml-package'

export function assertOfficeDocxPackage(bytes: Buffer): void {
  const entries = officePackageEntries(bytes)
  const required = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']
  if (required.some((entry) => !entries.has(entry))) {
    throw new Error('missing docx package part')
  }
}
