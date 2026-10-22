import assert from 'node:assert/strict'
import test from 'node:test'
import {
  expandDisplayFormulaShortcut,
  insertMarkdown,
  type MarkdownInsertSamples
} from '../src/renderer/src/features/analysis/notebook/markdownInsert'

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

test('inline marks wrap a selection and select an empty placeholder', () => {
  const wrapped = insertMarkdown('say hi now', 4, 6, 'bold', samples)
  assert.equal(wrapped.value, 'say **hi** now')
  assert.equal(wrapped.selectionStart, wrapped.value.length - 4)

  const empty = insertMarkdown('say ', 4, 4, 'italic', samples)
  assert.equal(empty.value, 'say *text*')
  assert.equal(empty.value.slice(empty.selectionStart, empty.selectionEnd), 'text')
})

test('links and images leave the address selected when nothing is selected', () => {
  const link = insertMarkdown('', 0, 0, 'link', samples)
  assert.equal(link.value, '[link](https://)')
  assert.equal(link.value.slice(link.selectionStart, link.selectionEnd), 'https://')

  const image = insertMarkdown('see ', 4, 4, 'image', samples)
  assert.equal(image.value, 'see ![image](image.png)')
  assert.equal(image.value.slice(image.selectionStart, image.selectionEnd), 'image.png')
})

test('a formula in a paragraph stays inline and a formula on its own line is a block', () => {
  const inline = insertMarkdown('energy ', 7, 7, 'formula', samples)
  assert.equal(inline.value, 'energy $$E = mc^2$$')

  const block = insertMarkdown('note\n', 5, 5, 'formula', samples)
  assert.equal(block.value, 'note\n\n$$\nE = mc^2\n$$\n\n\n')
  assert.equal(block.value.slice(block.selectionStart, block.selectionEnd), 'E = mc^2')

  const selectedBlock = insertMarkdown('Before x\ny After', 7, 10, 'formula', samples)
  assert.equal(selectedBlock.value, 'Before \n\n$$\nx\ny\n$$\n\n\n After')
})

test('two dollar signs on an otherwise empty line insert one bounded formula block', () => {
  const source = '# Title\n\n$\n\n- Item\n\nAfter'
  const result = expandDisplayFormulaShortcut(source, 10)
  assert.ok(result)
  assert.equal(result.value, '# Title\n\n$$\n\n$$\n\n\n- Item\n\nAfter')
  assert.equal(result.selectionStart, '# Title\n\n$$\n'.length)
  assert.equal(result.selectionEnd, result.selectionStart)
  assert.equal(expandDisplayFormulaShortcut('cost $', 6), null)
})

test('lists, quotes, code, and tables insert as blocks without sticking to the previous line', () => {
  const list = insertMarkdown('done', 4, 4, 'list', samples)
  assert.equal(list.value, 'done\n\n- item')
  assert.equal(list.value.slice(list.selectionStart, list.selectionEnd), 'item')

  const quote = insertMarkdown('a\nb', 0, 3, 'quote', samples)
  assert.equal(quote.value, '> a\n> b')

  const code = insertMarkdown('', 0, 0, 'codeBlock', samples)
  assert.equal(code.value, '```\n\n```\n\n\n')
  assert.equal(code.selectionStart, 4)
  assert.equal(code.selectionEnd, 4)

  const selectedCode = insertMarkdown('print(1)', 0, 8, 'codeBlock', samples)
  assert.equal(selectedCode.value, '```\nprint(1)\n```\n\n\n')
  assert.equal(selectedCode.selectionStart, 12)

  const before = insertMarkdown('before', 6, 6, 'codeBlock', samples)
  assert.equal(before.value, 'before\n\n```\n\n```\n\n\n')
  assert.equal(before.value.slice(before.selectionStart), '\n```\n\n\n')

  const table = insertMarkdown('', 0, 0, 'table', samples)
  assert.equal(table.value, '| A | B |\n| --- | --- |\n|  |  |')
  assert.equal(table.value.slice(table.selectionStart - 2, table.selectionStart + 1), '|  ')
  assert.equal(table.selectionStart, table.selectionEnd)
})
