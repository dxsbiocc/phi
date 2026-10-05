import { officePackageEntries } from './office-open-xml-package'

export function assertOfficeXlsxPackage(bytes: Buffer): void {
  const entries = officePackageEntries(bytes)
  const required = [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels'
  ]
  if (
    required.some((entry) => !entries.has(entry)) ||
    ![...entries].some((entry) => /^xl\/worksheets\/sheet[^/]*\.xml$/u.test(entry))
  ) {
    throw new Error('missing xlsx package part')
  }
}
