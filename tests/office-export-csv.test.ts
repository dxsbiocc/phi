import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  serializeOfficeDelimited,
  type OfficeExportSerializedData
} from '../src/main/agent/office/office-export-csv'
import type { OfficeExportSheetData } from '../src/main/agent/office/office-export-contract'
import { parseOfficeDelimitedBytes } from '../src/main/agent/office/office-import-csv'

function serialize(
  values: OfficeExportSheetData['values'],
  format: 'csv' | 'tsv' = 'csv'
): OfficeExportSerializedData {
  return serializeOfficeDelimited(
    { revision: 7, sheet: 'Data', rows: values.length, columns: values[0]?.length ?? 0, values },
    format
  )
}

describe('Office CSV/TSV serialization', () => {
  it('round-trips commas, quotes, line breaks, Unicode, and empty fields through the importer', () => {
    const values = [
      ['名称', '备注', '空'],
      ['张三😀', '逗号,双引号"和\n换行', null]
    ] as const

    const result = serialize(values)

    assert.equal(result.bytes[0], Buffer.from('名')[0])
    assert.equal(result.bytes.toString('utf8'), '名称,备注,空\n张三😀,"逗号,双引号""和\n换行",\n')
    assert.equal(result.rows, 2)
    assert.equal(result.columns, 3)
    assert.deepEqual(parseOfficeDelimitedBytes(result.bytes, 'csv').values, [
      ['名称', '备注', '空'],
      ['张三😀', '逗号,双引号"和\n换行', '']
    ])
  })

  it('trims only trailing empty rows and columns while preserving internal gaps and text', () => {
    const values = [
      ['007', null, '=1+1', null],
      [null, null, null, null],
      [42, true, 'comma,value', null],
      [null, null, null, null]
    ] as const

    const result = serialize(values, 'tsv')

    assert.equal(result.rows, 3)
    assert.equal(result.columns, 3)
    assert.equal(result.bytes.toString('utf8'), '007\t\t=1+1\n\t\t\n42\tTRUE\tcomma,value\n')
    assert.deepEqual(parseOfficeDelimitedBytes(result.bytes, 'tsv').values, [
      ['007', '', '=1+1'],
      ['', '', ''],
      ['42', 'TRUE', 'comma,value']
    ])
  })

  it('quotes TSV tabs, CR, LF, CRLF, and quotes while ordinary commas stay in one field', () => {
    const result = serialize(
      [['tab\tvalue', 'comma,value', 'quote"value', 'line\rbreak', 'crlf\r\nline', '换行\n🚀']],
      'tsv'
    )

    assert.equal(
      result.bytes.toString('utf8'),
      '"tab\tvalue"\tcomma,value\t"quote""value"\t"line\rbreak"\t"crlf\r\nline"\t"换行\n🚀"\n'
    )
    assert.deepEqual(parseOfficeDelimitedBytes(result.bytes, 'tsv').values, [
      ['tab\tvalue', 'comma,value', 'quote"value', 'line\rbreak', 'crlf\nline', '换行\n🚀']
    ])
  })

  it('keeps long and formula-prefixed text unchanged and rejects unsafe numeric/output states', () => {
    const long = '长'.repeat(32_767)
    const result = serialize([['=SUM(A1:A2)', '+1', '-1', '@name', '007', long]])
    assert.deepEqual(parseOfficeDelimitedBytes(result.bytes, 'csv').values, [
      ['=SUM(A1:A2)', '+1', '-1', '@name', '007', long]
    ])
    assert.throws(
      () =>
        serializeOfficeDelimited(
          { revision: 1, sheet: 'Data', rows: 1, columns: 1, values: [[Number.POSITIVE_INFINITY]] },
          'csv'
        ),
      { code: 'computed_value_unavailable' }
    )
    assert.throws(() => serialize([['x'.repeat(16 * 1024 * 1024 + 1)]]), {
      code: 'export_too_large'
    })
  })
})
