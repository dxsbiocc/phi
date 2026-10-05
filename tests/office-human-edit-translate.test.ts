import assert from 'node:assert/strict'
import test from 'node:test'

import { translateOfficeHumanCellText } from '../src/main/agent/office/office-human-edit-translate'

test('human cell text translates formulas, strict numbers, exact booleans, clears, and strings', () => {
  const translate = (text: string): unknown =>
    translateOfficeHumanCellText({ sheet: 'Sheet1', cell: 'A1', text })

  assert.deepEqual(translate('=SUM(B1:B2)'), {
    type: 'set_formula',
    sheet: 'Sheet1',
    cell: 'A1',
    formula: '=SUM(B1:B2)'
  })
  assert.deepEqual(translate('12'), { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: 12 })
  assert.deepEqual(translate('-3.5'), {
    type: 'set_cell',
    sheet: 'Sheet1',
    cell: 'A1',
    value: -3.5
  })
  assert.deepEqual(translate('1e3'), {
    type: 'set_cell',
    sheet: 'Sheet1',
    cell: 'A1',
    value: 1_000
  })
  assert.deepEqual(translate('-0'), {
    type: 'set_cell',
    sheet: 'Sheet1',
    cell: 'A1',
    value: -0
  })
  assert.deepEqual(translate('TRUE'), {
    type: 'set_cell',
    sheet: 'Sheet1',
    cell: 'A1',
    value: true
  })
  assert.deepEqual(translate('FALSE'), {
    type: 'set_cell',
    sheet: 'Sheet1',
    cell: 'A1',
    value: false
  })
  assert.deepEqual(translate(''), { type: 'clear_cell', sheet: 'Sheet1', cell: 'A1' })
  for (const text of ['007', 'true', 'False', '  5 ', '+1', '01', '.5', '1.', '1,000', '∞']) {
    assert.deepEqual(translate(text), {
      type: 'set_cell',
      sheet: 'Sheet1',
      cell: 'A1',
      value: text
    })
  }
  assert.throws(() => translate('1e999'), { code: 'invalid_value' })
})
