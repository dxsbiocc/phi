import assert from 'node:assert/strict'
import test from 'node:test'
import { inlineMathAt, inlineMathRanges } from '../src/renderer/src/lib/markdown/markdownInlineMath'

test('double-dollar formulas are located without currency or escaped markers', () => {
  const source = 'Cost $5, $$O(n)$$, $$E=mc^2$$, \\$$escaped and $O(n)$ plain'
  const ranges = inlineMathRanges(source)
  assert.deepEqual(
    ranges.map((range) => range.body),
    ['O(n)', 'E=mc^2']
  )
  assert.equal(inlineMathAt(source, ranges[0].from)?.body, 'O(n)')
})

test('inline code and multiline display formulas are not inline math', () => {
  assert.deepEqual(
    inlineMathRanges('`$$code$$` and $$real$$').map((range) => range.body),
    ['real']
  )
  assert.deepEqual(inlineMathRanges('$$\nE=mc^2\n$$'), [])
})
