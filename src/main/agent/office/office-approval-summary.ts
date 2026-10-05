import {
  OFFICE_WRITE_LIMITS,
  type OfficeCellEditDescription,
  type OfficeCellValue,
  type OfficeFormulaEditDescription,
  type OfficeFormatRangeDescription,
  type OfficeAddSheetDescription,
  type OfficeRangeEditDescription
} from './office-write-contract'

const MAX_SUMMARY_VALUE_CHARACTERS = 72

export function formatCellApprovalSummary(description: OfficeCellEditDescription): string {
  const target = `${visibleText(description.sheet)}!${visibleText(description.cell)}`
  const before = visibleValue(description.before)
  const after = visibleValue(description.after)
  const documentName = visibleText(description.documentName)
  return `将 ${target} 从「${before}」改为「${after}」（文档：${documentName}）`
}

export function formatRangeApprovalSummary(description: OfficeRangeEditDescription): string {
  const target = `${visibleText(description.sheet)}!${visibleText(description.range)}`
  const previews = description.preview
    .slice(0, OFFICE_WRITE_LIMITS.maxPreviewCells)
    .map(
      (entry) =>
        `${visibleText(entry.cell)}「${visibleValue(entry.before)}」→「${visibleValue(entry.after)}」`
    )
    .join('；')
  const summary = `将 ${target}（${description.rowCount} 行 × ${description.columnCount} 列，共 ${description.cellCount} 格）写入新值；其中 ${description.changedCells} 格将改变现有内容${previews ? `；前几格预览：${previews}` : ''}（文档：${visibleText(description.documentName)}）`
  const characters = [...summary]
  return characters.length <= OFFICE_WRITE_LIMITS.maxApprovalSummaryCharacters
    ? summary
    : `${characters.slice(0, OFFICE_WRITE_LIMITS.maxApprovalSummaryCharacters - 6).join('')}…（截断）`
}

export function formatFormulaApprovalSummary(description: OfficeFormulaEditDescription): string {
  const target = `${visibleText(description.sheet)}!${visibleText(description.cell)}`
  const formula = visibleText(description.formula)
  const before = description.before.formula
    ? `公式 \`${visibleText(description.before.formula)}\``
    : `「${visibleValue(description.before.value)}」`
  return `将 ${target} 写入公式 \`${formula}\`（当前内容：${before}）`
}

export function formatFormatApprovalSummary(description: OfficeFormatRangeDescription): string {
  const target = `${visibleText(description.sheet)}!${visibleText(description.range)}`
  const labels = [
    description.format.bold === undefined
      ? undefined
      : description.format.bold
        ? '加粗'
        : '取消加粗',
    description.format.fill ? `背景色 ${description.format.fill}` : undefined,
    description.format.horizontalAlign
      ? alignmentLabel(description.format.horizontalAlign)
      : undefined,
    description.format.numberFormat ? `数字格式 ${description.format.numberFormat}` : undefined
  ].filter((label): label is string => Boolean(label))
  return `将 ${target}（${description.rowCount} 行 × ${description.columnCount} 列，共 ${description.cellCount} 格）设置格式：${labels.join('、')}；其中 ${description.changedCells} 格当前格式将改变`
}

export function formatAddSheetApprovalSummary(description: OfficeAddSheetDescription): string {
  return `新建工作表「${visibleText(description.name)}」（当前共 ${description.sheetCount} 个工作表）`
}

function alignmentLabel(value: 'left' | 'center' | 'right'): string {
  if (value === 'left') return '左对齐'
  if (value === 'center') return '居中'
  return '右对齐'
}

function visibleValue(value: OfficeCellValue | null): string {
  if (value === null) return '空白'
  return visibleText(String(value))
}

export function visibleText(value: string): string {
  const escaped = replaceControlCharacters(value.replace(/\r\n|\r|\n/gu, '↵').replace(/\t/gu, '⇥'))
    .replace(/[\u202A-\u202E\u2066-\u2069]/gu, '�')
    .replaceAll('&', '＆')
    .replaceAll('<', '‹')
    .replaceAll('>', '›')
    .replaceAll('`', '｀')
    .replaceAll('「', '﹁')
    .replaceAll('」', '﹂')
  const characters = [...escaped]
  if (characters.length <= MAX_SUMMARY_VALUE_CHARACTERS) return escaped
  return `${characters.slice(0, MAX_SUMMARY_VALUE_CHARACTERS).join('')}…（已截断）`
}

function replaceControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f) ? '�' : character
    })
    .join('')
}
