export type ParsedHtmlTable = {
  headers: string[]
  rows: string[][]
  columnTypes: string[]
}

function decodeHtmlText(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"'
  }

  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity: string) => {
      const normalized = entity.toLowerCase()
      if (normalized.startsWith('#x')) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16))
      }
      if (normalized.startsWith('#')) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10))
      }
      return entities[normalized] ?? match
    })
    .replace(/\u00a0/g, ' ')
    .trim()
}

function parseCells(rowHtml: string): { tag: string; text: string }[] {
  return Array.from(rowHtml.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)).map(
    ([, tag, cellHtml]) => ({
      tag: tag.toLowerCase(),
      text: decodeHtmlText(cellHtml)
    })
  )
}

function parseRows(html: string): { tag: string; text: string }[][] {
  return Array.from(html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi))
    .map(([, rowHtml]) => parseCells(rowHtml))
    .filter((row) => row.length > 0)
}

function tableSectionHtml(tableHtml: string, section: 'thead' | 'tbody'): string | null {
  return tableHtml.match(new RegExp(`<${section}\\b[\\s\\S]*?<\\/${section}>`, 'i'))?.[0] ?? null
}

function inferColumnType(values: string[]): string {
  const nonEmptyValues = values.map((value) => value.trim()).filter(Boolean)
  if (nonEmptyValues.length === 0) return 'object'

  const numericValues = nonEmptyValues.filter((value) =>
    Number.isFinite(Number(value.replace(/,/g, '')))
  )
  if (numericValues.length === nonEmptyValues.length) {
    return numericValues.every((value) => /^-?\d+$/.test(value.replace(/,/g, '')))
      ? 'int64'
      : 'float64'
  }

  return 'object'
}

export function parseHtmlTable(html: string): ParsedHtmlTable | null {
  const tableHtml = html.match(/<table\b[\s\S]*?<\/table>/i)?.[0]
  if (!tableHtml) return null

  const headRows = parseRows(tableSectionHtml(tableHtml, 'thead') ?? '')
  const bodyRows = parseRows(tableSectionHtml(tableHtml, 'tbody') ?? '')
  const parsedRows = parseRows(tableHtml)

  if (parsedRows.length === 0) return null

  const firstRow = headRows[0] ?? parsedRows[0]
  const firstRowIsHeader = firstRow.every((cell) => cell.tag === 'th')
  let headers = firstRowIsHeader
    ? firstRow.map((cell) => cell.text)
    : firstRow.map((_, index) => `Column ${index + 1}`)
  let rows =
    firstRowIsHeader && bodyRows.length > 0
      ? bodyRows.map((row) => row.map((cell) => cell.text))
      : (firstRowIsHeader ? parsedRows.slice(1) : parsedRows).map((row) =>
          row.map((cell) => cell.text)
        )

  const pandasIndexNameRow =
    headRows.length > 1 &&
    bodyRows.length > 0 &&
    headRows[1].length === headers.length &&
    headRows[1][0]?.tag === 'th' &&
    headRows[1][0].text.length > 0 &&
    headRows[1].slice(1).every((cell) => cell.text === '') &&
    bodyRows.every((row) => row.length === headers.length)

  if (pandasIndexNameRow) {
    headers = [headRows[1][0].text, ...headers.slice(1)]
    rows = bodyRows.map((row) => row.map((cell) => cell.text))
  }

  const hasPandasIndex =
    headers[0] === '' &&
    rows.length > 0 &&
    rows.every((row) => row.length === headers.length && /^\d+$/.test(row[0] ?? ''))

  const normalizedHeaders = hasPandasIndex ? headers.slice(1) : headers
  const normalizedRows = hasPandasIndex ? rows.map((row) => row.slice(1)) : rows

  if (normalizedHeaders.length === 0) return null

  return {
    headers: normalizedHeaders.map((header, index) => header || `Column ${index + 1}`),
    rows: normalizedRows,
    columnTypes: normalizedHeaders.map((_, columnIndex) =>
      inferColumnType(normalizedRows.map((row) => row[columnIndex] ?? ''))
    )
  }
}
