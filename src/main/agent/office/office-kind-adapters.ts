import type { OfficeDocumentKind } from '../../../shared/officeProtocol'
import { assertOfficeDocxPackage } from './office-docx-package'
import { assertOfficePptxPackage } from './office-pptx-package'
import { assertOfficeXlsxPackage } from './office-xlsx-package'

export interface OfficeKindAdapter {
  readonly kind: OfficeDocumentKind
  readonly extension: '.xlsx' | '.docx' | '.pptx'
  readonly defaultName: string
  readonly displayName: 'Excel 工作簿' | 'Word 文档' | 'PowerPoint 演示文稿'
  readonly humanEdit: 'cells' | 'none'
  readonly assertPackage: (bytes: Buffer) => void
}

const OFFICE_KIND_ADAPTERS: Readonly<Record<OfficeDocumentKind, OfficeKindAdapter>> = Object.freeze(
  {
    xlsx: Object.freeze({
      kind: 'xlsx',
      extension: '.xlsx',
      defaultName: '空白表格.xlsx',
      displayName: 'Excel 工作簿',
      humanEdit: 'cells',
      assertPackage: assertOfficeXlsxPackage
    }),
    docx: Object.freeze({
      kind: 'docx',
      extension: '.docx',
      defaultName: '未命名文档.docx',
      displayName: 'Word 文档',
      humanEdit: 'none',
      assertPackage: assertOfficeDocxPackage
    }),
    pptx: Object.freeze({
      kind: 'pptx',
      extension: '.pptx',
      defaultName: '未命名演示文稿.pptx',
      displayName: 'PowerPoint 演示文稿',
      humanEdit: 'none',
      assertPackage: assertOfficePptxPackage
    })
  }
)

export function officeKindAdapter(kind: OfficeDocumentKind): OfficeKindAdapter {
  return OFFICE_KIND_ADAPTERS[kind]
}
