import assert from 'node:assert/strict'
import test from 'node:test'
import { history, undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { Decoration } from '@codemirror/view'
import {
  markdownInlineDecorations,
  markdownInlinePresentation
} from '../src/renderer/src/features/file-preview/lib/markdownInlineDecorations'

function stateAt(source: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({
    doc: source,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdown({ base: markdownLanguage })]
  })
}

function visibleSource(state: EditorState, focused = true): string {
  const { hidden } = markdownInlinePresentation(state, 0, state.doc.length, focused)
  let visible = ''
  let from = 0
  for (const range of hidden) {
    visible += state.sliceDoc(from, range.from)
    from = range.to
  }
  return visible + state.sliceDoc(from)
}

test('a plain caret keeps neighboring inline Markdown rendered and hides link destinations', () => {
  const source = 'Plain **bold** *italic* ~~strike~~ `code` [label](https://example.com "title")'
  const state = stateAt(source, 2)
  assert.equal(visibleSource(state), 'Plain bold italic strike code label')
  assert.deepEqual(
    markdownInlinePresentation(state, 0, source.length, true).marks.map((mark) => mark.className),
    [
      'phi-inline-strong',
      'phi-inline-emphasis',
      'phi-inline-strike',
      'phi-inline-code',
      'phi-inline-link'
    ]
  )
  assert.doesNotThrow(() =>
    Decoration.set(markdownInlineDecorations(state, 0, source.length, true), true)
  )
})

test('a caret reveals only its formatted fragment rather than all Markdown on the line', () => {
  const source = 'Plain **bold** and *italic* plus `code`'
  assert.equal(
    visibleSource(stateAt(source, source.indexOf('bold') + 2)),
    'Plain **bold** and italic plus code'
  )
  assert.equal(
    visibleSource(stateAt(source, source.indexOf('italic') + 2)),
    'Plain bold and *italic* plus code'
  )
  assert.equal(
    visibleSource(stateAt(source, source.indexOf('code') + 2)),
    'Plain bold and italic plus `code`'
  )
  assert.equal(
    visibleSource(stateAt(source, source.indexOf('bold') + 2), false),
    'Plain bold and italic plus code'
  )
})

test('nested emphasis reveals its smallest containing fragment and preserves sibling formatting', () => {
  const source = '**outer _inner_ end** and **sibling**'
  assert.equal(
    visibleSource(stateAt(source, source.indexOf('inner') + 2)),
    'outer _inner_ end and sibling'
  )
  assert.equal(
    visibleSource(stateAt(source, source.indexOf('outer') + 2)),
    '**outer inner end** and sibling'
  )
})

test('links reveal their own source locally without exposing unrelated bold or nested emphasis', () => {
  const source = '**bold** [label *inner*](https://example.com "title") and *end*'
  assert.equal(
    visibleSource(stateAt(source, source.indexOf('label') + 2)),
    'bold [label inner](https://example.com "title") and end'
  )
  assert.equal(
    visibleSource(stateAt(source, source.indexOf('inner') + 2)),
    'bold label *inner* and end'
  )
})

test('selections reveal only intersected syntax and select-all exposes exact source', () => {
  const source = '**one** and *two* [label](url)'
  assert.equal(visibleSource(stateAt(source, 2, 5)), 'one and two label')
  assert.equal(visibleSource(stateAt(source, 0, 1)), '**one and two label')
  assert.equal(visibleSource(stateAt(source, 2, 15)), 'one** and *two label')
  assert.equal(visibleSource(stateAt(source, 0, source.length)), source)
})

test('reference links hide syntax while images retain their source', () => {
  const source = 'Plain [label][ref] ![alt **kept**](image.png)\n\n[ref]: /target'
  assert.equal(
    visibleSource(stateAt(source, 2)),
    'Plain label ![alt **kept**](image.png)\n\n[ref]: /target'
  )
})

test('presentation never rewrites source and continues to use parser positions after edits', () => {
  const source = 'Plain **bold** and *italic*'
  const state = EditorState.create({
    doc: source,
    selection: { anchor: source.indexOf('bold') + 2 },
    extensions: [markdown({ base: markdownLanguage }), history()]
  })
  markdownInlineDecorations(state, 0, source.length, true)
  assert.equal(state.doc.toString(), source)
  let edited = state.update({
    changes: { from: 0, insert: 'New ' },
    selection: { anchor: 2 }
  }).state
  assert.equal(visibleSource(edited), 'New Plain bold and italic')
  assert.equal(edited.doc.toString(), `New ${source}`)
  assert.equal(
    undo({
      state: edited,
      dispatch(transaction) {
        edited = transaction.state
      }
    }),
    true
  )
  assert.equal(edited.doc.toString(), source)
})
