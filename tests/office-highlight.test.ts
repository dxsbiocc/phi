import assert from 'node:assert/strict'
import test from 'node:test'

import {
  highlightRangeContainsCell,
  officeHighlightTarget,
  parseOfficeHighlightRange
} from '../src/main/agent/office/office-highlight'

test('spreadsheet write operations map to normalized highlight targets', () => {
  assert.deepEqual(
    officeHighlightTarget({ type: 'set_cell', sheet: 'Sheet1', cell: 'a1', value: 'x' }),
    { sheet: 'Sheet1', range: 'A1' }
  )
  assert.deepEqual(
    officeHighlightTarget({ type: 'set_formula', sheet: '计算表', cell: 'B2', formula: '=1+1' }),
    { sheet: '计算表', range: 'B2' }
  )
  assert.deepEqual(
    officeHighlightTarget({
      type: 'set_range',
      sheet: 'Sheet1',
      range: 'a1:b3',
      values: [
        ['1', '2'],
        ['3', '4'],
        ['5', '6']
      ],
      rowCount: 3,
      columnCount: 2,
      cellCount: 6
    }),
    { sheet: 'Sheet1', range: 'A1:B3' }
  )
  assert.deepEqual(
    officeHighlightTarget({
      type: 'format_range',
      sheet: 'Sheet1',
      range: 'C4:D5',
      format: { bold: true },
      rowCount: 2,
      columnCount: 2,
      cellCount: 4
    }),
    { sheet: 'Sheet1', range: 'C4:D5' }
  )
})

test('non-cell and non-XLSX operations do not produce spreadsheet highlights', () => {
  assert.deepEqual(officeHighlightTarget({ type: 'add_sheet', name: '汇总表' }), {
    sheet: '汇总表'
  })
  assert.equal(officeHighlightTarget({ type: 'add_paragraph', text: '正文' }), undefined)
  assert.equal(
    officeHighlightTarget({
      type: 'set_slide_text',
      slideId: 'slide-1',
      elementId: 'element-1',
      text: '标题'
    }),
    undefined
  )
})

test('highlight ranges use detailed cells up to 2000 and a boundary above the limit', () => {
  const detailed = parseOfficeHighlightRange('A1:J200')
  assert.equal(detailed.cellCount, 2_000)
  assert.equal(detailed.boundaryOnly, false)
  assert.equal(highlightRangeContainsCell(detailed, 'E100'), true)

  const boundary = parseOfficeHighlightRange('A1:J201')
  assert.equal(boundary.cellCount, 2_010)
  assert.equal(boundary.boundaryOnly, true)
  assert.equal(highlightRangeContainsCell(boundary, 'A100'), true)
  assert.equal(highlightRangeContainsCell(boundary, 'E1'), true)
  assert.equal(highlightRangeContainsCell(boundary, 'J201'), true)
  assert.equal(highlightRangeContainsCell(boundary, 'E100'), false)
})

test('highlight targets reject invalid sheet and range authority', () => {
  assert.throws(() => parseOfficeHighlightRange('A0:B2'), /高亮范围无效/u)
  assert.throws(() => parseOfficeHighlightRange('B2:A1'), /高亮范围无效/u)
  assert.throws(
    () =>
      officeHighlightTarget({
        type: 'set_cell',
        sheet: '../other',
        cell: 'A1',
        value: 'x'
      }),
    /工作表名称无效/u
  )
})
