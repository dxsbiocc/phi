import { TextDecoder } from 'node:util'

import {
  OfficeImportError,
  type OfficeDelimitedFormat,
  type ParsedOfficeDelimitedData
} from './office-import-contract'
import {
  assertOfficeImportCellLength,
  assertOfficeImportDimensions,
  assertOfficeImportFileSize,
  OFFICE_IMPORT_LIMITS
} from './office-import-limits'

export type { OfficeDelimitedFormat, ParsedOfficeDelimitedData } from './office-import-contract'

interface ParserState {
  readonly rows: string[][]
  readonly row: string[]
  field: string
  fieldCharacters: number
  maxColumns: number
  quoted: boolean
  afterQuote: boolean
}

function decodeUtf8(bytes: Buffer): string {
  assertOfficeImportFileSize(bytes.length)
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new OfficeImportError('unsupported_encoding', '仅支持 UTF-8 编码的 CSV/TSV 文件')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')
  } catch (error) {
    throw new OfficeImportError(
      'unsupported_encoding',
      '仅支持有效 UTF-8 编码的 CSV/TSV 文件',
      undefined,
      { cause: error }
    )
  }
}

function finishField(state: ParserState): void {
  assertOfficeImportCellLength(state.field, state.rows.length + 1, state.row.length + 1)
  state.row.push(state.field)
  assertOfficeImportDimensions(state.rows.length + 1, Math.max(state.maxColumns, state.row.length))
  state.field = ''
  state.fieldCharacters = 0
  state.afterQuote = false
}

function finishRow(state: ParserState): void {
  finishField(state)
  state.maxColumns = Math.max(state.maxColumns, state.row.length)
  assertOfficeImportDimensions(state.rows.length + 1, state.maxColumns)
  state.rows.push(state.row.splice(0))
}

function invalidDelimitedText(message: string): never {
  throw new OfficeImportError('invalid_delimited_text', message)
}

function appendField(state: ParserState, value: string): void {
  const previous = state.field.charCodeAt(state.field.length - 1)
  const current = value.charCodeAt(0)
  const completesSurrogatePair =
    previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff
  state.field += value
  if (!completesSurrogatePair) state.fieldCharacters += 1
  if (state.fieldCharacters > OFFICE_IMPORT_LIMITS.maxCellTextLength) {
    assertOfficeImportCellLength(state.field, state.rows.length + 1, state.row.length + 1)
  }
}

function consumeQuoted(text: string, index: number, state: ParserState): number {
  const character = text[index]!
  if (character !== '"') {
    appendField(state, character === '\r' && text[index + 1] === '\n' ? '\n' : character)
    return character === '\r' && text[index + 1] === '\n' ? index + 1 : index
  }
  if (text[index + 1] === '"') {
    appendField(state, '"')
    return index + 1
  }
  state.quoted = false
  state.afterQuote = true
  return index
}

function consumeUnquoted(
  text: string,
  index: number,
  delimiter: ',' | '\t',
  state: ParserState
): number {
  const character = text[index]!
  if (state.afterQuote && character !== delimiter && character !== '\r' && character !== '\n') {
    return invalidDelimitedText('结束引号后只能出现分隔符或换行')
  }
  if (character === delimiter) {
    finishField(state)
    return index
  }
  if (character === '\n' || character === '\r') {
    if (character === '\r' && text[index + 1] !== '\n') {
      return invalidDelimitedText('CSV/TSV 记录必须使用 LF 或 CRLF 换行')
    }
    finishRow(state)
    return character === '\r' ? index + 1 : index
  }
  if (character === '"') {
    if (state.field.length > 0 || state.afterQuote)
      return invalidDelimitedText('字段中的引号必须转义')
    state.quoted = true
    return index
  }
  appendField(state, character)
  return index
}

function rectangularRows(rows: string[][]): readonly (readonly string[])[] {
  const columns = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  assertOfficeImportDimensions(rows.length, columns)
  return Object.freeze(
    rows.map((row, rowIndex) =>
      Object.freeze(
        Array.from({ length: columns }, (_, columnIndex) => {
          const value = row[columnIndex] ?? ''
          assertOfficeImportCellLength(value, rowIndex + 1, columnIndex + 1)
          return value
        })
      )
    )
  )
}

function parseDelimited(text: string, delimiter: ',' | '\t'): readonly (readonly string[])[] {
  if (text.length === 0) return Object.freeze([])
  const state: ParserState = {
    rows: [],
    row: [],
    field: '',
    fieldCharacters: 0,
    maxColumns: 0,
    quoted: false,
    afterQuote: false
  }
  for (let index = 0; index < text.length; index += 1) {
    index = state.quoted
      ? consumeQuoted(text, index, state)
      : consumeUnquoted(text, index, delimiter, state)
  }
  if (state.quoted) invalidDelimitedText('CSV/TSV 包含未闭合的引号字段')
  const endedWithLineBreak = text.endsWith('\n')
  if (!endedWithLineBreak || state.row.length > 0 || state.field.length > 0 || state.afterQuote) {
    finishRow(state)
  }
  return rectangularRows(state.rows)
}

export function parseOfficeDelimitedBytes(
  bytes: Buffer,
  format: OfficeDelimitedFormat
): ParsedOfficeDelimitedData {
  const delimiter = format === 'csv' ? ',' : '\t'
  const values = parseDelimited(decodeUtf8(bytes), delimiter)
  return Object.freeze({
    format,
    delimiter,
    values,
    rows: values.length,
    columns: values[0]?.length ?? 0
  })
}
