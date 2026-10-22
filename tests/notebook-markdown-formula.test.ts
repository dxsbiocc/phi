import assert from 'node:assert/strict'
import test from 'node:test'
import {
  displayMathAt,
  paragraphAfterDisplayMath,
  replaceDisplayMathBody
} from '../src/renderer/src/features/analysis/notebook/markdownDisplayMath'

test('display math source exposes only the expression body', () => {
  const source = 'before\n\n$$\nE = mc^2\n$$\n\nafter'
  const block = displayMathAt(source, 8)
  assert.ok(block)
  assert.equal(block.body, 'E = mc^2')
  assert.equal(source.slice(block.bodyStart, block.bodyEnd), 'E = mc^2')
  assert.equal(source.slice(block.closingEnd), '\n\nafter')
})

test('editing a formula keeps its Markdown delimiters and surrounding text', () => {
  assert.equal(
    replaceDisplayMathBody('$$\nE = mc^2\n$$\n\nAfter', 0, 'a^2 + b^2'),
    '$$\na^2 + b^2\n$$\n\nAfter'
  )
})

test('formula exit exposes a writable paragraph below', () => {
  const result = paragraphAfterDisplayMath('$$\nE=mc^2\n$$', 0)
  assert.deepEqual(result, { value: '$$\nE=mc^2\n$$\n\n', cursor: 14 })
})
