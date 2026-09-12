import type { FilePreview } from '../types'

export type SpreadsheetFormat = 'csv' | 'tsv'

export type SpreadsheetPreviewModel = {
  format: SpreadsheetFormat
  rows: string[][]
  columnCount: number
  rowsTruncated: boolean
  columnsTruncated: boolean
}

const SPREADSHEET_ROW_LIMIT = 250
const SPREADSHEET_COLUMN_LIMIT = 60

export function spreadsheetFormatForPath(path: string): SpreadsheetFormat | null {
  const name = path.split('/').pop()?.toLowerCase() ?? path.toLowerCase()
  if (name.endsWith('.csv')) return 'csv'
  if (name.endsWith('.tsv') || name.endsWith('.tab')) return 'tsv'
  return null
}

function spreadsheetDelimiter(format: SpreadsheetFormat): string {
  return format === 'tsv' ? '\t' : ','
}

export function parseDelimitedText(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  const pushCell = (): void => {
    row.push(cell)
    cell = ''
  }

  const pushRow = (): void => {
    pushCell()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (inQuotes) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        inQuotes = false
      } else {
        cell += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === delimiter) {
      pushCell()
      continue
    }
    if (char === '\n') {
      pushRow()
      continue
    }
    if (char === '\r') {
      if (text[index + 1] === '\n') index += 1
      pushRow()
      continue
    }

    cell += char
  }

  if (cell.length > 0 || row.length > 0 || text.endsWith(delimiter)) pushRow()
  return rows
}

export function spreadsheetColumnLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}

export function spreadsheetPreviewModel(
  file: Extract<FilePreview, { kind: 'text' }>
): SpreadsheetPreviewModel | null {
  const format = spreadsheetFormatForPath(file.path)
  if (!format) return null

  const parsedRows = parseDelimitedText(file.content, spreadsheetDelimiter(format))
  const rows = parsedRows.slice(0, SPREADSHEET_ROW_LIMIT)
  const sourceColumnCount = Math.max(1, ...parsedRows.map((row) => row.length))
  const columnCount = Math.min(sourceColumnCount, SPREADSHEET_COLUMN_LIMIT)

  return {
    format,
    rows: rows.map((row) => row.slice(0, columnCount)),
    columnCount,
    rowsTruncated: parsedRows.length > rows.length,
    columnsTruncated: sourceColumnCount > columnCount
  }
}
