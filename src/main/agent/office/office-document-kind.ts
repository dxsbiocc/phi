import { extname } from 'node:path'

import type { OfficeDocumentKind } from '../../../shared/officeProtocol'

export const OFFICE_DOCUMENT_KINDS = Object.freeze(['xlsx', 'docx', 'pptx'] as const)
export const OFFICE_UNSUPPORTED_WORD_HUMAN_EDIT_MESSAGE =
  '当前关联的是 Word 文档，暂不支持在预览中人工编辑正文'
export const OFFICE_UNSUPPORTED_POWERPOINT_HUMAN_EDIT_MESSAGE =
  '当前关联的是 PowerPoint 演示文稿，暂不支持在预览中人工编辑幻灯片'
export const OFFICE_UNSUPPORTED_POWERPOINT_TOOL_MESSAGE =
  '当前关联的是 PowerPoint 演示文稿，暂不支持通过工具读取/修改（后续版本支持）'

export function parseOfficeDocumentKind(value: unknown): OfficeDocumentKind {
  if (value === undefined || value === 'xlsx') return 'xlsx'
  if (value === 'docx') return 'docx'
  if (value === 'pptx') return 'pptx'
  throw new Error('Office 文档类型无效，仅支持 xlsx、docx 或 pptx')
}

export function officeDocumentKindFromPath(path: string): OfficeDocumentKind {
  const extension = extname(path).toLowerCase()
  if (extension === '.xlsx') return 'xlsx'
  if (extension === '.docx') return 'docx'
  if (extension === '.pptx') return 'pptx'
  throw new Error('仅支持 .xlsx、.docx 或 .pptx 文件的 Office 实时预览')
}

export function officeArtifactKind(value: Readonly<Record<string, unknown>>): OfficeDocumentKind {
  return parseOfficeDocumentKind(value.kind)
}
