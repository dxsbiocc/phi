import assert from 'node:assert/strict'
import test from 'node:test'

import { parseOfficeHumanCellEditBody } from '../src/main/agent/office/office-human-edit'

test('human edit parser accepts allowed unicode, tab, newline, and maximum cell text', () => {
  for (const value of ['中文🙂', 'a\tb', 'a\nb', 'x'.repeat(32_767)]) {
    assert.deepEqual(
      parseOfficeHumanCellEditBody(
        JSON.stringify({ path: '/工作表 1/J1000', prop: 'text', value })
      ),
      { sheet: '工作表 1', cell: 'J1000', text: value }
    )
  }
})

test('human edit parser rejects excessive text and every disallowed control range', () => {
  for (const value of [
    'x'.repeat(32_768),
    'a\rb',
    'a\u0000b',
    'a\u000bb',
    'a\u007fb',
    'a\u0085b'
  ]) {
    assert.throws(
      () =>
        parseOfficeHumanCellEditBody(JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value })),
      { code: 'invalid_edit' }
    )
  }
})
