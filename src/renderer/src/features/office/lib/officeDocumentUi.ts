import type {
  OfficeDocumentKind,
  OfficePreviewDocument
} from '../../../../../shared/officeProtocol'

export interface OfficeDocumentCopy {
  readonly productName: 'Excel' | 'Word' | 'PowerPoint'
  readonly createPlaceholder: string
  readonly formatName: 'XLSX' | 'DOCX' | 'PPTX'
}

const COPY_BY_KIND: Readonly<Record<OfficeDocumentKind, OfficeDocumentCopy>> = {
  xlsx: { productName: 'Excel', createPlaceholder: '空白工作簿', formatName: 'XLSX' },
  docx: { productName: 'Word', createPlaceholder: '未命名文档', formatName: 'DOCX' },
  pptx: {
    productName: 'PowerPoint',
    createPlaceholder: '未命名演示文稿',
    formatName: 'PPTX'
  }
}

export function officeDocumentKind(document: OfficePreviewDocument): OfficeDocumentKind {
  return document.kind ?? 'xlsx'
}

export function officeDocumentCopy(kind: OfficeDocumentKind): OfficeDocumentCopy {
  return COPY_BY_KIND[kind]
}

export function officeDocumentHumanEdit(document: OfficePreviewDocument): 'cells' | 'none' {
  return document.humanEdit ?? (officeDocumentKind(document) === 'xlsx' ? 'cells' : 'none')
}

export function officePanelErrorMessage(code: string, message: string): string {
  if (code !== 'preview_failed' || message.startsWith('预览渲染失败：')) return message
  return `预览渲染失败：${message}`
}
