import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeMarkdownSlash,
  filterMarkdownInsertKinds,
  insertFromMarkdownSlash
} from '../src/renderer/src/features/analysis/notebook/markdownSlash'
import type { MarkdownInsertSamples } from '../src/renderer/src/features/analysis/notebook/markdownInsert'

const samples: MarkdownInsertSamples = {
  text: 'text',
  link: 'link',
  formula: 'E = mc^2',
  image: 'image',
  list: 'item',
  quote: 'quote',
  columnA: 'A',
  columnB: 'B'
}

test('slash commands match at a word boundary on the current line', () => {
  assert.deepEqual(activeMarkdownSlash('say /bo', 7), { start: 4, end: 7, query: 'bo' })
  assert.deepEqual(activeMarkdownSlash('first\n/table', 12), {
    start: 6,
    end: 12,
    query: 'table'
  })
  assert.equal(activeMarkdownSlash('https://example', 15), null)
  assert.equal(activeMarkdownSlash('some/path', 9), null)
  assert.equal(activeMarkdownSlash('/table\nnext', 11), null)
})

test('slash choices remove the command token and preserve the inserted selection', () => {
  const source = 'say /bo'
  const match = activeMarkdownSlash(source, source.length)
  assert.ok(match)
  const result = insertFromMarkdownSlash(source, match, 'bold', samples)
  assert.equal(result.value, 'say **text**')
  assert.equal(result.value.slice(result.selectionStart, result.selectionEnd), 'text')
})

test('slash search accepts English aliases and localized labels', () => {
  const label = (kind: string): string => ({ bold: '粗体', table: '表格' })[kind] ?? kind
  assert.deepEqual(filterMarkdownInsertKinds('bo', label), ['bold'])
  assert.deepEqual(filterMarkdownInsertKinds('表', label), ['table'])
  assert.deepEqual(filterMarkdownInsertKinds('code', label), ['codeBlock'])
  assert.equal(filterMarkdownInsertKinds('ta', label)[0], 'table')
})
