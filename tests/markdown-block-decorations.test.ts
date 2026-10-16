import assert from 'node:assert/strict'
import test from 'node:test'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { Decoration } from '@codemirror/view'
import { markdownBlockDecorations } from '../src/renderer/src/features/file-preview/lib/markdownBlockDecorations'

function stateAt(source: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({
    doc: source,
    selection: { anchor, head },
    extensions: [markdown({ base: markdownLanguage })]
  })
}

function decorations(
  state: EditorState,
  focused = true
): ReturnType<typeof markdownBlockDecorations> {
  return markdownBlockDecorations(state, 0, state.doc.length, focused)
}

function displayedSource(state: EditorState): string {
  const replacements = decorations(state)
    .filter((range) => range.to > range.from && !range.value.spec.class)
    .sort((left, right) => left.from - right.from)
  let content = ''
  let from = 0
  for (const range of replacements) {
    content += state.sliceDoc(from, range.from) + (range.value.spec.widget?.label ?? '')
    from = range.to
  }
  return content + state.sliceDoc(from)
}

test('list and task markers remain rendered when the caret is in item text', () => {
  const source = '- One\n- [x] Done\n- [ ] Pending'
  const state = stateAt(source, source.indexOf('Done') + 2)
  assert.equal(displayedSource(state), '• One\n• [x] Done\n• [ ] Pending')
  const tasks = decorations(state).filter((range) => range.value.spec.widget?.kind === 'task')
  assert.equal(tasks.length, 2)
  assert.deepEqual(
    tasks.map((range) => range.value.spec.widget.label),
    ['[x]', '[ ]']
  )
  assert.doesNotThrow(() => Decoration.set(decorations(state), true))
  assert.equal(state.doc.toString(), source)
})

test('only the marker under the caret is exposed, including its end before the following space', () => {
  const source = '- One\n- [x] Done'
  assert.equal(displayedSource(stateAt(source, 1)), '- One\n• [x] Done')
  const task = source.indexOf('[x]')
  assert.equal(
    decorations(stateAt(source, task + 1)).some(
      (range) => range.value.spec.widget?.kind === 'task'
    ),
    false
  )
  assert.equal(
    decorations(stateAt(source, task + 3)).some(
      (range) => range.value.spec.widget?.kind === 'task'
    ),
    false
  )
  assert.equal(
    decorations(stateAt(source, task + 4)).some(
      (range) => range.value.spec.widget?.kind === 'task'
    ),
    true
  )
})

test('ordered list labels use the first item ordinal rather than repeated source numbers', () => {
  assert.equal(displayedSource(stateAt('1. One\n1. Two', 4)), '1. One\n2. Two')
  const source = '3. Third\n1. Fourth\n1. Fifth\n\n0) Zero\n1) One'
  assert.equal(
    displayedSource(stateAt(source, source.indexOf('Third') + 2)),
    '3. Third\n4. Fourth\n5. Fifth\n\n0. Zero\n1. One'
  )
  assert.equal(stateAt(source, 4).doc.toString(), source)
})

test('nested list rows use level-based padding and source indentation is recoverable', () => {
  const source = '- Outer\n  - Inner\n    - Deep'
  const state = stateAt(source, source.indexOf('Outer') + 2)
  const rows = decorations(state).filter(
    (range) => range.value.spec.class === 'phi-inline-list-line'
  )
  assert.deepEqual(
    rows.map((range) => range.value.spec.attributes.style),
    ['padding-left: 24px', 'padding-left: 48px', 'padding-left: 72px']
  )
  assert.equal(displayedSource(state), '• Outer\n• Inner\n• Deep')
  const indent = source.indexOf('  -')
  assert.equal(displayedSource(stateAt(source, indent, indent + 1)), '• Outer\n  • Inner\n• Deep')
})

test('quote markers are independent replacements and selecting one preserves unrelated quotes', () => {
  const source = '> Quote\n> Next'
  assert.equal(displayedSource(stateAt(source, 3)), ' Quote\n Next')
  assert.equal(displayedSource(stateAt(source, 0, 1)), '> Quote\n Next')
  assert.equal(
    decorations(stateAt(source, 3)).filter((range) => range.value.spec.widget?.kind === 'quote')
      .length,
    2
  )
})

test('fenced code hides only fence lines and retains every body byte including blank lines', () => {
  const source = '```ts\nconst a = 1\n\nconst b = 2\n```\n\nEnd'
  const state = stateAt(source, source.indexOf('const a') + 4)
  assert.equal(displayedSource(state), 'const a = 1\n\nconst b = 2\n\nEnd')
  assert.equal(
    displayedSource(stateAt(source, source.indexOf('const a'))),
    'const a = 1\n\nconst b = 2\n\nEnd'
  )
  const fences = decorations(state).filter((range) => range.value.spec.block === true)
  assert.equal(fences.length, 2)
  assert.equal(
    decorations(state).filter((range) => range.value.spec.class === 'phi-inline-fenced-line')
      .length,
    3
  )
  assert.equal(displayedSource(stateAt(source, 3)), '```ts\nconst a = 1\n\nconst b = 2\n\nEnd')
  assert.equal(state.doc.toString(), source)
})

test('selection exposes only intersected markers and select-all restores exact structural source', () => {
  for (const source of ['- [x] Done\n  - Child', '> Quote\n> Next', '```py\nprint(1)\n```']) {
    assert.equal(displayedSource(stateAt(source, 0, source.length)), source)
  }
  const source = '- One\n- Two'
  assert.equal(displayedSource(stateAt(source, 0, 1)), '- One\n• Two')
})
