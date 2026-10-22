import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fencedCodeAt,
  replaceFencedCodeBody,
  replaceFencedCodeLanguage,
  paragraphAfterFencedCode
} from '../src/renderer/src/features/analysis/notebook/markdownFencedCode'

test('fenced code exposes body and language ranges without treating later text as code', () => {
  const source = 'before\n\n```python\nprint(1)\n```\n\nafter'
  const block = fencedCodeAt(source, 8)
  assert.ok(block)
  assert.equal(block.language, 'python')
  assert.equal(block.body, 'print(1)')
  assert.equal(source.slice(block.languageStart, block.languageEnd), 'python')
  assert.equal(source.slice(block.bodyStart, block.bodyEnd), 'print(1)')
  assert.equal(source.slice(block.closingEnd), '\n\nafter')
})

test('code body and language edits preserve the surrounding Markdown', () => {
  const source = '```\n\n```\n\nafter'
  assert.equal(replaceFencedCodeBody(source, 0, 'x <- 1'), '```\nx <- 1\n```\n\nafter')
  assert.equal(replaceFencedCodeLanguage(source, 0, 'r'), '```r\n\n```\n\nafter')
})

test('leaving a last code block creates a writable paragraph after it', () => {
  const existing = paragraphAfterFencedCode('```r\nx <- 1\n```', 0)
  assert.deepEqual(existing, { value: '```r\nx <- 1\n```\n\n', cursor: 17 })
  const already = paragraphAfterFencedCode('```\n\n```\n\n', 0)
  assert.deepEqual(already, { value: '```\n\n```\n\n', cursor: 10 })
})
