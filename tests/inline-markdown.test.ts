import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorSelection, EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import {
  inlineMarkdownBlocks,
  inlineMarkdownExtension,
  markdownBlockIsSelected,
  markdownOffsetForVisibleText
} from '../src/renderer/src/lib/markdown/inlineMarkdown'

const source =
  '# Title\n\nParagraph **bold**.\n\n- A\n- B\n\n| a | b |\n|---|---|\n| x | y |\n\n```js\nx()\n```\n\n[ref]: https://example.com\n'
const makeState = (doc = source): EditorState =>
  EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage }),
      inlineMarkdownExtension(
        () => {},
        () => {}
      )
    ]
  })

test('inline Markdown uses complete top-level GFM blocks and leaves source intact', () => {
  const state = makeState()
  const blocks = inlineMarkdownBlocks(state)
  assert.deepEqual(
    blocks.map((block) => block.name),
    ['ATXHeading1', 'Paragraph', 'BulletList', 'Table', 'FencedCode', 'LinkReference']
  )
  assert.equal(state.sliceDoc(blocks[2].from, blocks[2].to), '- A\n- B')
  assert.equal(state.sliceDoc(blocks[3].from, blocks[3].to), '| a | b |\n|---|---|\n| x | y |')
  assert.equal(state.doc.toString(), source)
  assert.equal(
    state.update({ selection: EditorSelection.single(0, source.length) }).state.doc.toString(),
    source
  )
})

test('moving the caret reuses parsed blocks until the document changes', () => {
  const state = makeState('# Title\n\nParagraph')
  const blocks = inlineMarkdownBlocks(state)
  const moved = state.update({ selection: { anchor: 5 } }).state
  assert.equal(inlineMarkdownBlocks(moved), blocks)
  const edited = moved.update({ changes: { from: moved.doc.length, insert: '!' } }).state
  assert.notEqual(inlineMarkdownBlocks(edited), blocks)
})

test('selection across blocks always reveals selected source, even after blur', () => {
  const initial = makeState()
  const blocks = inlineMarkdownBlocks(initial)
  const cursor = initial.update({ selection: { anchor: blocks[1].from + 4 } }).state
  assert.equal(markdownBlockIsSelected(blocks[1], cursor, true), true)
  assert.equal(markdownBlockIsSelected(blocks[1], cursor, false), false)
  const selected = initial.update({ selection: { anchor: 2, head: blocks[3].to - 1 } }).state
  assert.deepEqual(
    blocks.map((block) => markdownBlockIsSelected(block, selected, false)),
    [true, true, true, true, false, false]
  )
  const all = initial.update({ selection: EditorSelection.single(0, source.length) }).state
  assert.ok(blocks.every((block) => markdownBlockIsSelected(block, all, false)))
})

test('heading recognition and edits retain exact Markdown delimiters', () => {
  let state = makeState('')
  state = state.update({ changes: { from: 0, insert: '# ' }, selection: { anchor: 2 } }).state
  assert.equal(inlineMarkdownBlocks(state)[0].name, 'ATXHeading1')
  state = state.update({ changes: { from: 2, insert: '标题' }, selection: { anchor: 4 } }).state
  assert.equal(state.doc.toString(), '# 标题')
  assert.equal(inlineMarkdownBlocks(state)[0].name, 'ATXHeading1')
})

test('visible text clicks align with original heading and emphasis source offsets', () => {
  assert.equal(markdownOffsetForVisibleText('# Hello', 'Hel'), 5)
  assert.equal(markdownOffsetForVisibleText('A **bold** word', 'A bold'), 8)
  assert.equal(markdownOffsetForVisibleText('# 标题😀', '标题😀'), 6)
})

test('display math with blank lines remains one rendered source range', () => {
  const equation = '$$\na+b\n\nc+d\n$$'
  const state = makeState(`# Title\n\n${equation}\n\nAfter`)
  const blocks = inlineMarkdownBlocks(state)
  assert.deepEqual(
    blocks.map((block) => block.name),
    ['ATXHeading1', 'Math', 'Paragraph']
  )
  assert.equal(state.sliceDoc(blocks[1].from, blocks[1].to), equation)
  assert.equal(state.doc.toString(), `# Title\n\n${equation}\n\nAfter`)
  const code = makeState('```text\n$$\na+b\n\nc+d\n$$\n```')
  assert.deepEqual(
    inlineMarkdownBlocks(code).map((block) => block.name),
    ['FencedCode']
  )
})

test('an unfinished formula opener never absorbs the blocks after it', () => {
  const state = makeState('# Title\n\n$$\n\n- Item\n\nAfter')
  const blocks = inlineMarkdownBlocks(state)
  assert.equal(
    blocks.some((block) => block.name === 'Math'),
    false
  )
  assert.equal(blocks[0].name, 'ATXHeading1')
  assert.equal(
    blocks.some((block) => block.name === 'BulletList'),
    true
  )
  assert.equal(state.sliceDoc(blocks.at(-1)!.from, blocks.at(-1)!.to), 'After')
})

test('a closed formula does not absorb adjacent paragraphs', () => {
  const state = makeState('Before\n$$\nE=mc^2\n$$\nAfter')
  const blocks = inlineMarkdownBlocks(state)
  assert.deepEqual(
    blocks.map((block) => block.name),
    ['Paragraph', 'Math', 'Paragraph']
  )
  assert.deepEqual(
    blocks.map((block) => state.sliceDoc(block.from, block.to).trim()),
    ['Before', '$$\nE=mc^2\n$$', 'After']
  )
})
