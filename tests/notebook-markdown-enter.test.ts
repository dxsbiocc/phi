import assert from 'node:assert/strict'
import test from 'node:test'
import {
  continueMarkdownOnEnter,
  moveToFencedCodeBody
} from '../src/renderer/src/features/analysis/notebook/markdownEnter'

test('Enter continues unordered, numbered, task, and quote blocks', () => {
  const cases = [
    ['- first', '- first\n- '],
    ['  * item', '  * item\n  * '],
    ['9. item', '9. item\n10. '],
    ['- [x] done', '- [x] done\n- [ ] '],
    ['> note', '> note\n> '],
    ['> - note', '> - note\n> - ']
  ] as const
  for (const [source, expected] of cases) {
    const result = continueMarkdownOnEnter(source, source.length, source.length)
    assert.equal(result?.value, expected, source)
    assert.equal(result?.selectionStart, expected.length)
    assert.equal(result?.selectionEnd, expected.length)
  }
})

test('Enter on an empty list or quote exits that format', () => {
  for (const source of ['- ', '1. ', '- [ ] ', '> ']) {
    const result = continueMarkdownOnEnter(source, source.length, source.length)
    assert.equal(result?.value, '', source)
    assert.equal(result?.selectionStart, 0)
  }
  const nested = continueMarkdownOnEnter('> - ', 4, 4)
  assert.equal(nested?.value, '> ')
})

test('Enter within a list item keeps following text on the next item', () => {
  const result = continueMarkdownOnEnter('- before after', 8, 8)
  assert.equal(result?.value, '- before\n- after')
  assert.equal(result?.selectionStart, 11)
})

test('plain lines, selections, and fenced code keep normal Enter behavior', () => {
  assert.equal(continueMarkdownOnEnter('plain', 5, 5), null)
  assert.equal(continueMarkdownOnEnter('- selected', 2, 10), null)
  assert.equal(continueMarkdownOnEnter('```r\n- code\n```', 10, 10), null)
})

test('Enter in a fenced language slot moves to the body', () => {
  const empty = moveToFencedCodeBody('```r\n\n```', 4, 4)
  assert.deepEqual(empty, { value: '```r\n\n```', selectionStart: 5, selectionEnd: 5 })
  const existing = moveToFencedCodeBody('```python\nprint(1)\n```', 9, 9)
  assert.deepEqual(existing, {
    value: '```python\nprint(1)\n```',
    selectionStart: 10,
    selectionEnd: 10
  })
  assert.equal(moveToFencedCodeBody('```r\ncode\n```', 7, 7), null)
})
