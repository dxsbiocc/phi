import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseOfficeDelimitedBytes,
  type OfficeDelimitedFormat
} from '../src/main/agent/office/office-import-csv'
import {
  OFFICE_IMPORT_LIMITS,
  assertOfficeImportDimensions
} from '../src/main/agent/office/office-import-limits'
import {
  classifyOfficeImportValue,
  convertOfficeImportRows
} from '../src/main/agent/office/office-import-values'

function parse(
  text: string,
  format: OfficeDelimitedFormat = 'csv'
): ReturnType<typeof parseOfficeDelimitedBytes> {
  return parseOfficeDelimitedBytes(Buffer.from(text, 'utf8'), format)
}

describe('Office CSV/TSV strict parsing', () => {
  it('parses quotes, escaped quotes, embedded newlines, Chinese, and empty fields', () => {
    const parsed = parse('\ufeffname,note,empty\r\n"张三","逗号,双引号""和\r\n换行",\r\n')

    assert.equal(parsed.rows, 2)
    assert.equal(parsed.columns, 3)
    assert.deepEqual(parsed.values, [
      ['name', 'note', 'empty'],
      ['张三', '逗号,双引号"和\n换行', '']
    ])
  })

  it('parses TSV and .tab semantics without treating commas as delimiters', () => {
    const parsed = parse('left\t"comma,value"\t"line\nfeed"\t\n', 'tsv')

    assert.equal(parsed.delimiter, '\t')
    assert.deepEqual(parsed.values, [['left', 'comma,value', 'line\nfeed', '']])
  })

  it('pads ragged rows without inventing a trailing record', () => {
    const parsed = parse('a,b,c\n1,2\n')

    assert.deepEqual(parsed.values, [
      ['a', 'b', 'c'],
      ['1', '2', '']
    ])
  })

  it('defines empty, single-column, and header-only files', () => {
    assert.deepEqual(parse('').values, [])
    assert.deepEqual(parse('only').values, [['only']])
    assert.deepEqual(parse('header\n').values, [['header']])
  })

  it('rejects malformed quoting and unsupported encodings', () => {
    assert.throws(() => parse('a,"unterminated\n'), {
      code: 'invalid_delimited_text'
    })
    assert.throws(() => parse('a,b"c\n'), { code: 'invalid_delimited_text' })
    assert.throws(() => parseOfficeDelimitedBytes(Buffer.from([0xc3, 0x28]), 'csv'), {
      code: 'unsupported_encoding'
    })
    assert.throws(() => parseOfficeDelimitedBytes(Buffer.from([0xff, 0xfe, 0x61, 0x00]), 'csv'), {
      code: 'unsupported_encoding'
    })
  })

  it('rejects source bytes and individual cells above their explicit limits', () => {
    assert.throws(
      () =>
        parseOfficeDelimitedBytes(Buffer.alloc(OFFICE_IMPORT_LIMITS.maxFileBytes + 1, 0x61), 'csv'),
      { code: 'import_too_large' }
    )
    assert.throws(() => parse('a\n' + 'x'.repeat(OFFICE_IMPORT_LIMITS.maxCellTextLength + 1)), {
      code: 'import_too_large'
    })
  })

  it('rejects adversarial row and column counts incrementally at the first excess item', () => {
    for (const [bytes, expected] of [
      [Buffer.alloc(OFFICE_IMPORT_LIMITS.maxFileBytes, 0x0a), { rows: 1_001, columns: 1 }],
      [Buffer.alloc(OFFICE_IMPORT_LIMITS.maxFileBytes, 0x2c), { rows: 1, columns: 101 }]
    ] as const) {
      assert.throws(
        () => parseOfficeDelimitedBytes(bytes, 'csv'),
        (error: unknown) => {
          const value = error as { code?: unknown; details?: Record<string, unknown> }
          assert.equal(value.code, 'import_too_large')
          assert.equal(value.details?.rows, expected.rows)
          assert.equal(value.details?.columns, expected.columns)
          return true
        }
      )
    }
  })
})

describe('Office import value typing', () => {
  it('imports only unambiguous finite decimals as numbers', () => {
    const cases = new Map<string, 'number' | 'string'>([
      ['0', 'number'],
      ['42', 'number'],
      ['-1', 'number'],
      ['3.50', 'number'],
      ['007', 'string'],
      ['1e3', 'string'],
      ['=SUM(A1)', 'string'],
      ['+1', 'string'],
      ['@x', 'string'],
      ['2026-10-06', 'string'],
      ['1,000', 'string'],
      ['１２３', 'string'],
      ['9007199254740992', 'string'],
      ['1234567890123456.5', 'string'],
      [`0.${'0'.repeat(400)}1`, 'string'],
      [`-0.${'0'.repeat(400)}1`, 'string'],
      ['', 'string']
    ])

    for (const [source, expectedType] of cases) {
      assert.equal(classifyOfficeImportValue(source).type, expectedType, source)
    }
    assert.deepEqual(convertOfficeImportRows([['007', '-1', '=1+2', '3.50']]), [
      ['007', -1, '=1+2', 3.5]
    ])
  })
})

describe('Office import limits', () => {
  it('accepts 1,000 x 80 and rejects row, column, cell, and file-size overflow', () => {
    assert.doesNotThrow(() => assertOfficeImportDimensions(1_000, 80))

    for (const dimensions of [
      [OFFICE_IMPORT_LIMITS.maxRows + 1, 1],
      [1, OFFICE_IMPORT_LIMITS.maxColumns + 1],
      [Math.floor(OFFICE_IMPORT_LIMITS.maxCells / OFFICE_IMPORT_LIMITS.maxColumns) + 1, 100],
      [OFFICE_IMPORT_LIMITS.maxRows, OFFICE_IMPORT_LIMITS.maxColumns + 1]
    ] as const) {
      assert.throws(() => assertOfficeImportDimensions(dimensions[0], dimensions[1]), {
        code: 'import_too_large'
      })
    }
  })
})
